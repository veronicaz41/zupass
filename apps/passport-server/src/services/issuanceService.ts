import { EdDSAFrogPCDPackage, IFrogData } from "@pcd/eddsa-frog-pcd";
import {
  EdDSAPublicKey,
  getEdDSAPublicKey,
  isEqualEdDSAPublicKey
} from "@pcd/eddsa-pcd";
import {
  EdDSATicketPCD,
  EdDSATicketPCDPackage,
  ITicketData,
  TicketCategory
} from "@pcd/eddsa-ticket-pcd";
import { EmailPCD, EmailPCDPackage } from "@pcd/email-pcd";
import { getHash } from "@pcd/passport-crypto";
import {
  CheckTicketByIdRequest,
  CheckTicketByIdResult,
  CheckTicketInByIdRequest,
  CheckTicketInByIdResult,
  FeedHost,
  GetOfflineTicketsRequest,
  GetOfflineTicketsResponseValue,
  ISSUANCE_STRING,
  KnownPublicKeyType,
  KnownTicketGroup,
  KnownTicketTypesResult,
  ListFeedsRequest,
  ListFeedsResponseValue,
  ListSingleFeedRequest,
  PollFeedRequest,
  PollFeedResponseValue,
  UploadOfflineCheckinsRequest,
  UploadOfflineCheckinsResponseValue,
  VerifyTicketByIdRequest,
  VerifyTicketByIdResult,
  VerifyTicketRequest,
  VerifyTicketResult,
  ZUCONNECT_23_DAY_PASS_PRODUCT_ID,
  ZUCONNECT_PRODUCT_ID_MAPPINGS,
  ZUZALU_23_EVENT_ID,
  ZUZALU_23_ORGANIZER_PRODUCT_ID,
  ZUZALU_23_RESIDENT_PRODUCT_ID,
  ZUZALU_23_VISITOR_PRODUCT_ID,
  ZupassFeedIds,
  ZuzaluUserRole,
  verifyFeedCredential,
  zupassDefaultSubscriptions
} from "@pcd/passport-interface";
import {
  PCDAction,
  PCDActionType,
  PCDPermissionType,
  joinPath
} from "@pcd/pcd-collection";
import { ArgumentTypeName, SerializedPCD } from "@pcd/pcd-types";
import { RSAImagePCDPackage } from "@pcd/rsa-image-pcd";
import {
  SemaphoreSignaturePCD,
  SemaphoreSignaturePCDPackage
} from "@pcd/semaphore-signature-pcd";
import { ONE_HOUR_MS, getErrorMessage } from "@pcd/util";
import { ZKEdDSAEventTicketPCDPackage } from "@pcd/zk-eddsa-event-ticket-pcd";
import { Response } from "express";
import _ from "lodash";
import { LRUCache } from "lru-cache";
import NodeRSA from "node-rsa";
import { Pool } from "postgres-pool";
import urljoin from "url-join";
import {
  DevconnectPretixTicketDBWithEmailAndItem,
  UserRow
} from "../database/models";
import { checkInOfflineTickets } from "../database/multitableQueries/checkInOfflineTickets";
import { fetchOfflineTicketsForChecker } from "../database/multitableQueries/fetchOfflineTickets";
import {
  fetchDevconnectPretixTicketByTicketId,
  fetchDevconnectPretixTicketsByEmail,
  fetchDevconnectSuperusersForEmail
} from "../database/queries/devconnect_pretix_tickets/fetchDevconnectPretixTicket";
import { consumeDevconnectPretixTicket } from "../database/queries/devconnect_pretix_tickets/updateDevconnectPretixTicket";
import {
  fetchKnownPublicKeys,
  fetchKnownTicketByEventAndProductId,
  fetchKnownTicketTypes,
  setKnownPublicKey,
  setKnownTicketType
} from "../database/queries/knownTicketTypes";
import { fetchUserByCommitment } from "../database/queries/users";
import {
  fetchZuconnectTicketById,
  fetchZuconnectTicketsByEmail
} from "../database/queries/zuconnect/fetchZuconnectTickets";
import { fetchLoggedInZuzaluUser } from "../database/queries/zuzalu_pretix_tickets/fetchZuzaluUser";
import { PCDHTTPError } from "../routing/pcdHttpError";
import { ApplicationContext } from "../types";
import { logger } from "../util/logger";
import { timeBasedId } from "../util/timeBasedId";
import {
  zuconnectProductIdToEventId,
  zuconnectProductIdToName
} from "../util/zuconnectTicket";
import { zuzaluRoleToProductId } from "../util/zuzaluUser";
import { MultiProcessService } from "./multiProcessService";
import { PersistentCacheService } from "./persistentCacheService";
import { RollbarService } from "./rollbarService";
import { traced } from "./telemetryService";

export const ZUPASS_TICKET_PUBLIC_KEY_NAME = "Zupass";

export class IssuanceService {
  private readonly context: ApplicationContext;
  private readonly cacheService: PersistentCacheService;
  private readonly rollbarService: RollbarService | null;
  private readonly feedHost: FeedHost;
  private readonly eddsaPrivateKey: string;
  private readonly rsaPrivateKey: NodeRSA;
  private readonly exportedRSAPrivateKey: string;
  private readonly exportedRSAPublicKey: string;
  private readonly multiprocessService: MultiProcessService;
  private readonly verificationPromiseCache: LRUCache<string, Promise<boolean>>;

  public constructor(
    context: ApplicationContext,
    cacheService: PersistentCacheService,
    multiprocessService: MultiProcessService,
    rollbarService: RollbarService | null,
    rsaPrivateKey: NodeRSA,
    eddsaPrivateKey: string
  ) {
    this.context = context;
    this.cacheService = cacheService;
    this.multiprocessService = multiprocessService;
    this.rollbarService = rollbarService;
    this.rsaPrivateKey = rsaPrivateKey;
    this.exportedRSAPrivateKey = this.rsaPrivateKey.exportKey("private");
    this.exportedRSAPublicKey = this.rsaPrivateKey.exportKey("public");
    this.eddsaPrivateKey = eddsaPrivateKey;
    this.verificationPromiseCache = new LRUCache<string, Promise<boolean>>({
      max: 1000
    });
    this.cachedVerifySignaturePCD = this.cachedVerifySignaturePCD.bind(this);

    this.feedHost = new FeedHost(
      [
        {
          handleRequest: async (
            req: PollFeedRequest
          ): Promise<PollFeedResponseValue> => {
            const actions: PCDAction[] = [];

            try {
              if (req.pcd === undefined) {
                throw new Error(`Missing credential`);
              }
              const { pcd } = await verifyFeedCredential(
                req.pcd,
                this.cachedVerifySignaturePCD
              );
              const pcds = await this.issueDevconnectPretixTicketPCDs(pcd);
              const ticketsByEvent = _.groupBy(
                pcds,
                (pcd) => pcd.claim.ticket.eventName
              );

              const devconnectTickets = Object.entries(ticketsByEvent).filter(
                ([eventName]) => eventName !== "SBC SRW"
              );

              const srwTickets = Object.entries(ticketsByEvent).filter(
                ([eventName]) => eventName === "SBC SRW"
              );

              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "SBC SRW",
                recursive: false
              });

              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "Devconnect",
                recursive: true
              });

              actions.push(
                ...(
                  await Promise.all(
                    devconnectTickets.map(async ([eventName, tickets]) => [
                      {
                        type: PCDActionType.ReplaceInFolder,
                        folder: joinPath("Devconnect", eventName),
                        pcds: await Promise.all(
                          tickets.map((pcd) =>
                            EdDSATicketPCDPackage.serialize(pcd)
                          )
                        )
                      }
                    ])
                  )
                ).flat()
              );

              actions.push(
                ...(await Promise.all(
                  srwTickets.map(async ([_, tickets]) => ({
                    type: PCDActionType.ReplaceInFolder,
                    folder: "SBC SRW",
                    pcds: await Promise.all(
                      tickets.map((pcd) => EdDSATicketPCDPackage.serialize(pcd))
                    )
                  }))
                ))
              );
            } catch (e) {
              logger(`Error encountered while serving feed:`, e);
              this.rollbarService?.reportError(e);
            }

            return { actions };
          },
          feed: zupassDefaultSubscriptions[ZupassFeedIds.Devconnect]
        },
        {
          handleRequest: async (
            req: PollFeedRequest
          ): Promise<PollFeedResponseValue> => {
            try {
              if (req.pcd === undefined) {
                throw new Error(`Missing credential`);
              }
              await verifyFeedCredential(
                req.pcd,
                this.cachedVerifySignaturePCD
              );
              return {
                actions: [
                  {
                    pcds: await this.issueFrogPCDs(),
                    folder: "Frogs",
                    type: PCDActionType.AppendToFolder
                  }
                ]
              };
            } catch (e) {
              logger(`Error encountered while serving feed:`, e);
              this.rollbarService?.reportError(e);
            }
            return { actions: [] };
          },
          feed: {
            id: ZupassFeedIds.Frogs,
            name: "Frogs",
            description: "Get your Frogs here!",
            inputPCDType: undefined,
            partialArgs: undefined,
            credentialRequest: {
              signatureType: "sempahore-signature-pcd"
            },
            permissions: [
              {
                folder: "Frogs",
                type: PCDPermissionType.AppendToFolder
              }
            ]
          }
        },
        {
          handleRequest: async (
            req: PollFeedRequest
          ): Promise<PollFeedResponseValue> => {
            const actions: PCDAction[] = [];

            try {
              if (req.pcd === undefined) {
                throw new Error(`Missing credential`);
              }
              const { pcd } = await verifyFeedCredential(
                req.pcd,
                this.cachedVerifySignaturePCD
              );
              const pcds = await this.issueEmailPCDs(pcd);

              // Clear out the folder
              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "Email",
                recursive: false
              });

              actions.push({
                type: PCDActionType.ReplaceInFolder,
                folder: "Email",
                pcds: await Promise.all(
                  pcds.map((pcd) => EmailPCDPackage.serialize(pcd))
                )
              });
            } catch (e) {
              logger(`Error encountered while serving feed:`, e);
              this.rollbarService?.reportError(e);
            }

            return { actions };
          },
          feed: zupassDefaultSubscriptions[ZupassFeedIds.Email]
        },
        {
          handleRequest: async (
            req: PollFeedRequest
          ): Promise<PollFeedResponseValue> => {
            const actions: PCDAction[] = [];
            if (req.pcd === undefined) {
              throw new Error(`Missing credential`);
            }
            try {
              const { pcd } = await verifyFeedCredential(
                req.pcd,
                this.cachedVerifySignaturePCD
              );
              const pcds = await this.issueZuzaluTicketPCDs(pcd);

              // Clear out the folder
              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "Zuzalu '23",
                recursive: false
              });

              actions.push({
                type: PCDActionType.ReplaceInFolder,
                folder: "Zuzalu '23",
                pcds: await Promise.all(
                  pcds.map((pcd) => EdDSATicketPCDPackage.serialize(pcd))
                )
              });
            } catch (e) {
              logger(`Error encountered while serving feed:`, e);
              this.rollbarService?.reportError(e);
            }

            return { actions };
          },
          feed: zupassDefaultSubscriptions[ZupassFeedIds.Zuzalu_23]
        },
        {
          handleRequest: async (
            req: PollFeedRequest
          ): Promise<PollFeedResponseValue> => {
            const actions: PCDAction[] = [];
            if (req.pcd === undefined) {
              throw new Error(`Missing credential`);
            }
            try {
              const { pcd } = await verifyFeedCredential(
                req.pcd,
                this.cachedVerifySignaturePCD
              );

              const pcds = await this.issueZuconnectTicketPCDs(pcd);

              // Clear out the old folder
              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "Zuconnect",
                recursive: false
              });

              // Clear out the folder
              actions.push({
                type: PCDActionType.DeleteFolder,
                folder: "ZuConnect",
                recursive: false
              });

              actions.push({
                type: PCDActionType.ReplaceInFolder,
                folder: "ZuConnect",
                pcds: await Promise.all(
                  pcds.map((pcd) => EdDSATicketPCDPackage.serialize(pcd))
                )
              });
            } catch (e) {
              logger(`Error encountered while serving feed:`, e);
              this.rollbarService?.reportError(e);
            }

            return { actions };
          },
          feed: zupassDefaultSubscriptions[ZupassFeedIds.Zuconnect_23]
        }
      ],
      `${process.env.PASSPORT_SERVER_URL}/feeds`,
      "Zupass"
    );
  }

  public async handleListFeedsRequest(
    request: ListFeedsRequest
  ): Promise<ListFeedsResponseValue> {
    return this.feedHost.handleListFeedsRequest(request);
  }

  public async handleListSingleFeedRequest(
    request: ListSingleFeedRequest
  ): Promise<ListFeedsResponseValue> {
    return this.feedHost.handleListSingleFeedRequest(request);
  }

  public async handleFeedRequest(
    request: PollFeedRequest
  ): Promise<PollFeedResponseValue> {
    return this.feedHost.handleFeedRequest(request);
  }

  public hasFeedWithId(feedId: string): boolean {
    return this.feedHost.hasFeedWithId(feedId);
  }

  public getRSAPublicKey(): string {
    return this.exportedRSAPublicKey;
  }

  public getEdDSAPublicKey(): Promise<EdDSAPublicKey> {
    return getEdDSAPublicKey(this.eddsaPrivateKey);
  }

  public async handleDevconnectCheckInByIdRequest(
    request: CheckTicketInByIdRequest
  ): Promise<CheckTicketInByIdResult> {
    try {
      const ticketDB = await fetchDevconnectPretixTicketByTicketId(
        this.context.dbPool,
        request.ticketId
      );

      const signaturePCD = await SemaphoreSignaturePCDPackage.deserialize(
        request.checkerProof.pcd
      );

      const check = await this.checkDevconnectTicketById(
        request.ticketId,
        signaturePCD
      );
      if (check.success === false) {
        return check;
      }

      const ticketData = {
        ticketId: request.ticketId,
        eventId: ticketDB?.pretix_events_config_id
      };

      // We know this will succeed as it's also called by
      // checkDevconnectTicketById() above
      const checker = (await fetchUserByCommitment(
        this.context.dbPool,
        signaturePCD.claim.identityCommitment
      )) as UserRow;

      const successfullyConsumed = await consumeDevconnectPretixTicket(
        this.context.dbPool,
        ticketData.ticketId ?? "",
        checker.email
      );

      if (successfullyConsumed) {
        return {
          value: undefined,
          success: true
        };
      }

      return {
        error: {
          name: "ServerError",
          detailedMessage:
            "The server encountered an error. Please try again later."
        },
        success: false
      };
    } catch (e) {
      logger("Error when consuming devconnect ticket", { error: e });
      throw new PCDHTTPError(500, "failed to check in", { cause: e });
    }
  }

  /**
   * Checks that a ticket is valid for Devconnect check-in based on the ticket
   * data in the DB.
   */
  public async handleDevconnectCheckTicketByIdRequest(
    request: CheckTicketByIdRequest
  ): Promise<CheckTicketByIdResult> {
    try {
      const signaturePCD = await SemaphoreSignaturePCDPackage.deserialize(
        request.signature.pcd
      );
      return this.checkDevconnectTicketById(request.ticketId, signaturePCD);
    } catch (e) {
      return {
        error: { name: "ServerError" },
        success: false
      };
    }
  }

  /**
   * Checks a ticket for validity based on the ticket's status in the DB.
   */
  public async checkDevconnectTicketById(
    ticketId: string,
    signature: SemaphoreSignaturePCD
  ): Promise<CheckTicketByIdResult> {
    try {
      const ticketInDb = await fetchDevconnectPretixTicketByTicketId(
        this.context.dbPool,
        ticketId
      );

      if (!ticketInDb) {
        return {
          error: {
            name: "InvalidTicket",
            detailedMessage: "The ticket you tried to check in is not valid."
          },
          success: false
        };
      }

      if (ticketInDb.is_deleted) {
        return {
          error: {
            name: "TicketRevoked",
            revokedTimestamp: Date.now(),
            detailedMessage:
              "The ticket has been revoked. Please check with the event host."
          },
          success: false
        };
      }

      if (ticketInDb.is_consumed) {
        return {
          error: {
            name: "AlreadyCheckedIn",
            checker: ticketInDb.checker ?? undefined,
            checkinTimestamp: (
              ticketInDb.zupass_checkin_timestamp ?? new Date()
            ).toISOString()
          },
          success: false
        };
      }

      if (
        !(await SemaphoreSignaturePCDPackage.verify(signature)) ||
        signature.claim.signedMessage !== ISSUANCE_STRING
      ) {
        return {
          error: {
            name: "NotSuperuser",
            detailedMessage:
              "You do not have permission to check this ticket in. Please check with the event host."
          },

          success: false
        };
      }

      const checker = await this.checkUserExists(signature);

      if (!checker) {
        return {
          error: {
            name: "NotSuperuser",
            detailedMessage:
              "You do not have permission to check this ticket in. Please check with the event host."
          },
          success: false
        };
      }

      const checkerSuperUserPermissions =
        await fetchDevconnectSuperusersForEmail(
          this.context.dbPool,
          checker.email
        );

      const relevantSuperUserPermission = checkerSuperUserPermissions.find(
        (perm) =>
          perm.pretix_events_config_id === ticketInDb.pretix_events_config_id
      );

      if (!relevantSuperUserPermission) {
        return {
          error: {
            name: "NotSuperuser",
            detailedMessage:
              "You do not have permission to check this ticket in. Please check with the event host."
          },
          success: false
        };
      }

      return {
        value: {
          eventName: ticketInDb.event_name,
          attendeeEmail: ticketInDb.email,
          attendeeName: ticketInDb.full_name,
          ticketName: ticketInDb.item_name
        },
        success: true
      };
    } catch (e) {
      logger("Error when checking ticket", { error: e });
      return {
        error: { name: "ServerError", detailedMessage: getErrorMessage(e) },
        success: false
      };
    }
  }

  /**
   * Returns a promised verification of a PCD, either from the cache or,
   * if there is no cache entry, from the multiprocess service.
   */
  public async cachedVerifySignaturePCD(
    serializedPCD: SerializedPCD<SemaphoreSignaturePCD>
  ): Promise<boolean> {
    const key = JSON.stringify(serializedPCD);
    const cached = this.verificationPromiseCache.get(key);
    if (cached) {
      return cached;
    } else {
      const deserialized = await SemaphoreSignaturePCDPackage.deserialize(
        serializedPCD.pcd
      );
      const promise = SemaphoreSignaturePCDPackage.verify(deserialized);
      this.verificationPromiseCache.set(key, promise);
      // If the promise rejects, delete it from the cache
      promise.catch(() => this.verificationPromiseCache.delete(key));
      return promise;
    }
  }

  private async checkUserExists(
    signature: SemaphoreSignaturePCD
  ): Promise<UserRow | null> {
    const user = await fetchUserByCommitment(
      this.context.dbPool,
      signature.claim.identityCommitment
    );

    if (user == null) {
      logger(
        `can't issue PCDs for ${signature.claim.identityCommitment} because ` +
          `we don't have a user with that commitment in the database`
      );
      return null;
    }

    return user;
  }

  /**
   * Fetch all DevconnectPretixTicket entities under a given user's email.
   */
  private async issueDevconnectPretixTicketPCDs(
    credential: SemaphoreSignaturePCD
  ): Promise<EdDSATicketPCD[]> {
    return traced(
      "IssuanceService",
      "issueDevconnectPretixTicketPCDs",
      async (span) => {
        const commitmentRow = await this.checkUserExists(credential);
        const email = commitmentRow?.email;
        if (commitmentRow) {
          span?.setAttribute(
            "commitment",
            commitmentRow?.commitment?.toString() ?? ""
          );
        }
        if (email) {
          span?.setAttribute("email", email);
        }

        if (commitmentRow == null || email == null) {
          return [];
        }

        const commitmentId = commitmentRow.commitment.toString();
        const ticketsDB = await fetchDevconnectPretixTicketsByEmail(
          this.context.dbPool,
          email
        );

        const tickets = await Promise.all(
          ticketsDB
            .map((t) => IssuanceService.ticketRowToTicketData(t, commitmentId))
            .map((ticketData) => this.getOrGenerateTicket(ticketData))
        );

        span?.setAttribute("ticket_count", tickets.length);

        return tickets;
      }
    );
  }

  private async getOrGenerateTicket(
    ticketData: ITicketData
  ): Promise<EdDSATicketPCD> {
    return traced("IssuanceService", "getOrGenerateTicket", async (span) => {
      span?.setAttribute("ticket_id", ticketData.ticketId);
      span?.setAttribute("ticket_email", ticketData.attendeeEmail);
      span?.setAttribute("ticket_name", ticketData.attendeeName);

      const cachedTicket = await this.getCachedTicket(ticketData);

      if (cachedTicket) {
        return cachedTicket;
      }

      logger(`[ISSUANCE] cache miss for ticket id ${ticketData.ticketId}`);

      const generatedTicket = await IssuanceService.ticketDataToTicketPCD(
        ticketData,
        this.eddsaPrivateKey
      );

      try {
        this.cacheTicket(generatedTicket);
      } catch (e) {
        this.rollbarService?.reportError(e);
        logger(
          `[ISSUANCE] error caching ticket ${ticketData.ticketId} ` +
            `${ticketData.attendeeEmail} for ${ticketData.eventId} (${ticketData.eventName})`
        );
      }

      return generatedTicket;
    });
  }

  private static async getTicketCacheKey(
    ticketData: ITicketData
  ): Promise<string> {
    const ticketCopy: any = { ...ticketData };
    // the reason we remove `timestampSigned` from the cache key
    // is that it changes every time we instantiate `ITicketData`
    // for a particular devconnect ticket, rendering the caching
    // ineffective.
    delete ticketCopy.timestampSigned;
    const hash = await getHash(JSON.stringify(ticketCopy));
    return hash;
  }

  private async cacheTicket(ticket: EdDSATicketPCD): Promise<void> {
    const key = await IssuanceService.getTicketCacheKey(ticket.claim.ticket);
    const serialized = await EdDSATicketPCDPackage.serialize(ticket);
    this.cacheService.setValue(key, JSON.stringify(serialized));
  }

  private async getCachedTicket(
    ticketData: ITicketData
  ): Promise<EdDSATicketPCD | undefined> {
    const key = await IssuanceService.getTicketCacheKey(ticketData);
    const serializedTicket = await this.cacheService.getValue(key);
    if (!serializedTicket) {
      logger(`[ISSUANCE] cache miss for ticket id ${ticketData.ticketId}`);
      return undefined;
    }
    logger(`[ISSUANCE] cache hit for ticket id ${ticketData.ticketId}`);
    const parsedTicket = JSON.parse(serializedTicket.cache_value);

    try {
      const deserializedTicket = await EdDSATicketPCDPackage.deserialize(
        parsedTicket.pcd
      );
      return deserializedTicket;
    } catch (e) {
      logger("[ISSUANCE]", `failed to parse cached ticket ${key}`, e);
      this.rollbarService?.reportError(e);
      return undefined;
    }
  }

  private static async ticketDataToTicketPCD(
    ticketData: ITicketData,
    eddsaPrivateKey: string
  ): Promise<EdDSATicketPCD> {
    const stableId = await getHash("issued-ticket-" + ticketData.ticketId);

    const ticketPCD = await EdDSATicketPCDPackage.prove({
      ticket: {
        value: ticketData,
        argumentType: ArgumentTypeName.Object
      },
      privateKey: {
        value: eddsaPrivateKey,
        argumentType: ArgumentTypeName.String
      },
      id: {
        value: stableId,
        argumentType: ArgumentTypeName.String
      }
    });

    return ticketPCD;
  }

  private static ticketRowToTicketData(
    t: DevconnectPretixTicketDBWithEmailAndItem,
    semaphoreId: string
  ): ITicketData {
    return {
      // unsigned fields
      attendeeName: t.full_name,
      attendeeEmail: t.email,
      eventName: t.event_name,
      ticketName: t.item_name,
      checkerEmail: t.checker ?? undefined,

      // signed fields
      ticketId: t.id,
      eventId: t.pretix_events_config_id,
      productId: t.devconnect_pretix_items_info_id,
      timestampConsumed:
        t.zupass_checkin_timestamp == null
          ? 0
          : new Date(t.zupass_checkin_timestamp).getTime(),
      timestampSigned: Date.now(),
      attendeeSemaphoreId: semaphoreId,
      isConsumed: t.is_consumed,
      isRevoked: t.is_deleted,
      ticketCategory: TicketCategory.Devconnect
    } satisfies ITicketData;
  }

  private async issueFrogPCDs(): Promise<SerializedPCD[]> {
    const FROG_INTERVAL_MS = 1000 * 60 * 10; // one new frog every ten minutes
    // Images are served from passport-client's web host
    const imageServerUrl = process.env.PASSPORT_CLIENT_URL;

    if (!imageServerUrl) {
      logger(
        "[ISSUE] can't issue frogs - unaware of the image server location"
      );
      return [];
    }

    const frogPaths: string[] = [
      "images/frogs/frog.jpeg",
      "images/frogs/frog2.jpeg",
      "images/frogs/frog3.jpeg",
      "images/frogs/frog4.jpeg"
    ];

    const randomFrogPath = _.sample(frogPaths);

    const id = timeBasedId(FROG_INTERVAL_MS) + "";

    const frogPCD = await RSAImagePCDPackage.serialize(
      await RSAImagePCDPackage.prove({
        privateKey: {
          argumentType: ArgumentTypeName.String,
          value: this.exportedRSAPrivateKey
        },
        url: {
          argumentType: ArgumentTypeName.String,
          value: imageServerUrl + "/" + randomFrogPath
        },
        title: {
          argumentType: ArgumentTypeName.String,
          value: "frog " + id
        },
        id: {
          argumentType: ArgumentTypeName.String,
          value: id
        }
      })
    );

    return [frogPCD];
  }

  /**
   * Issue an EdDSAFrogPCD from IFrogData signed with IssuanceService's private key.
   */
  public async issueEdDSAFrogPCDs(
    credential: SerializedPCD<SemaphoreSignaturePCD>,
    frogData: IFrogData
  ): Promise<SerializedPCD[]> {
    const frogPCD = await EdDSAFrogPCDPackage.serialize(
      await EdDSAFrogPCDPackage.prove({
        privateKey: {
          argumentType: ArgumentTypeName.String,
          value: this.exportedRSAPrivateKey
        },
        data: {
          argumentType: ArgumentTypeName.Object,
          value: frogData
        },
        id: {
          argumentType: ArgumentTypeName.String
        }
      })
    );

    return [frogPCD];
  }

  /**
   * Issues email PCDs based on the user's verified email address.
   * Currently we only verify a single email address, but could provide
   * multiple PCDs if it were possible to verify secondary emails.
   */
  private async issueEmailPCDs(
    credential: SemaphoreSignaturePCD
  ): Promise<EmailPCD[]> {
    return traced(
      "IssuanceService",
      "issueDevconnectPretixTicketPCDs",
      async (span) => {
        const commitmentRow = await this.checkUserExists(credential);
        const email = commitmentRow?.email;
        if (commitmentRow) {
          span?.setAttribute(
            "commitment",
            commitmentRow?.commitment?.toString() ?? ""
          );
        }
        if (email) {
          span?.setAttribute("email", email);
        }

        if (commitmentRow == null || email == null) {
          return [];
        }

        const stableId = "attested-email-" + email;

        return [
          await EmailPCDPackage.prove({
            privateKey: {
              value: this.eddsaPrivateKey,
              argumentType: ArgumentTypeName.String
            },
            id: {
              value: stableId,
              argumentType: ArgumentTypeName.String
            },
            emailAddress: {
              value: email,
              argumentType: ArgumentTypeName.String
            },
            semaphoreId: {
              value: commitmentRow.commitment,
              argumentType: ArgumentTypeName.String
            }
          })
        ];
      }
    );
  }

  private async issueZuzaluTicketPCDs(
    credential: SemaphoreSignaturePCD
  ): Promise<EdDSATicketPCD[]> {
    return traced("IssuanceService", "issueZuzaluTicketPCDs", async (span) => {
      // The image we use for Zuzalu tickets is served from the same place
      // as passport-client.
      // This is the same mechanism as used in frog image PCDs.
      const imageServerUrl = process.env.PASSPORT_CLIENT_URL;

      if (!imageServerUrl) {
        logger(
          "[ISSUE] can't issue Zuzalu tickets - unaware of the image server location"
        );
        return [];
      }

      const commitmentRow = await this.checkUserExists(credential);
      const email = commitmentRow?.email;
      if (commitmentRow) {
        span?.setAttribute(
          "commitment",
          commitmentRow?.commitment?.toString() ?? ""
        );
      }
      if (email) {
        span?.setAttribute("email", email);
      }

      if (commitmentRow == null || email == null) {
        return [];
      }

      const user = await fetchLoggedInZuzaluUser(this.context.dbPool, {
        uuid: commitmentRow.uuid
      });

      const tickets = [];

      if (user) {
        tickets.push(
          await this.getOrGenerateTicket({
            attendeeSemaphoreId: user.commitment,
            eventName: "Zuzalu (March - May 2023)",
            checkerEmail: undefined,
            ticketId: user.uuid,
            ticketName: user.role.toString(),
            attendeeName: user.name,
            attendeeEmail: user.email,
            eventId: ZUZALU_23_EVENT_ID,
            productId: zuzaluRoleToProductId(user.role),
            timestampSigned: Date.now(),
            timestampConsumed: 0,
            isConsumed: false,
            isRevoked: false,
            ticketCategory: TicketCategory.Zuzalu,
            imageUrl: urljoin(imageServerUrl, "images/zuzalu", "zuzalu.png"),
            imageAltText: "Zuzalu logo"
          })
        );
      }

      return tickets;
    });
  }

  /**
   * Issues EdDSATicketPCD tickets to Zuconnect ticket holders.
   * It is technically possible for a user to have more than one ticket, e.g.
   * a day pass ticket-holder might upgrade to a full ticket.
   */
  private async issueZuconnectTicketPCDs(
    credential: SemaphoreSignaturePCD
  ): Promise<EdDSATicketPCD[]> {
    return traced(
      "IssuanceService",
      "issueZuconnectTicketPCDs",
      async (span) => {
        const user = await this.checkUserExists(credential);
        const email = user?.email;
        if (user) {
          span?.setAttribute("commitment", user?.commitment?.toString() ?? "");
        }
        if (email) {
          span?.setAttribute("email", email);
        }

        if (user == null || email == null) {
          return [];
        }

        const tickets = await fetchZuconnectTicketsByEmail(
          this.context.dbPool,
          email
        );

        const pcds = [];

        for (const ticket of tickets) {
          const ticketName =
            ticket.product_id === ZUCONNECT_23_DAY_PASS_PRODUCT_ID
              ? ticket.extra_info.join("\n")
              : zuconnectProductIdToName(ticket.product_id);
          pcds.push(
            await this.getOrGenerateTicket({
              attendeeSemaphoreId: user.commitment,
              eventName: "Zuconnect October-November '23",
              checkerEmail: undefined,
              ticketId: ticket.id,
              ticketName,
              attendeeName: `${ticket.attendee_name}`,
              attendeeEmail: ticket.attendee_email,
              eventId: zuconnectProductIdToEventId(ticket.product_id),
              productId: ticket.product_id,
              timestampSigned: Date.now(),
              timestampConsumed: 0,
              isConsumed: false,
              isRevoked: false,
              ticketCategory: TicketCategory.ZuConnect
            })
          );
        }

        return pcds;
      }
    );
  }

  /**
   * Verifies a ticket based on:
   * 1) verification of the PCD (that it is correctly formed, with a proof
   *    matching the claim)
   * 2) whether the ticket matches the ticket types known to us, e.g. Zuzalu
   *    or Zuconnect tickets
   *
   * Not used for Devconnect tickets, which have a separate check-in flow.
   * This is the default verification flow for ticket PCDs, based on the
   * standard QR code, but only Zuconnect/Zuzalu '23 tickets will be returned
   * as verified.
   */
  private async verifyZuconnect23OrZuzalu23Ticket(
    serializedPCD: SerializedPCD
  ): Promise<VerifyTicketResult> {
    if (!serializedPCD.type) {
      throw new Error("input was not a serialized PCD");
    }

    if (
      serializedPCD.type !== EdDSATicketPCDPackage.name &&
      serializedPCD.type !== ZKEdDSAEventTicketPCDPackage.name
    ) {
      throw new Error(
        `serialized PCD was wrong type, '${serializedPCD.type}' instead of '${EdDSATicketPCDPackage.name}' or '${ZKEdDSAEventTicketPCDPackage.name}'`
      );
    }

    let eventId: string;
    let productId: string;
    let publicKey: EdDSAPublicKey;

    if (serializedPCD.type === EdDSATicketPCDPackage.name) {
      const pcd = await EdDSATicketPCDPackage.deserialize(serializedPCD.pcd);

      if (!EdDSATicketPCDPackage.verify(pcd)) {
        return {
          success: true,
          value: { verified: false, message: "Could not verify PCD." }
        };
      }

      eventId = pcd.claim.ticket.eventId;
      productId = pcd.claim.ticket.productId;
      publicKey = pcd.proof.eddsaPCD.claim.publicKey;
    } else {
      const pcd = await ZKEdDSAEventTicketPCDPackage.deserialize(
        serializedPCD.pcd
      );

      if (!ZKEdDSAEventTicketPCDPackage.verify(pcd)) {
        return {
          success: true,
          value: { verified: false, message: "Could not verify PCD." }
        };
      }

      if (
        !(pcd.claim.partialTicket.eventId && pcd.claim.partialTicket.productId)
      ) {
        return {
          success: true,
          value: {
            verified: false,
            message: "PCD does not reveal the correct fields."
          }
        };
      }

      // Watermarks can be up to four hours old
      if (Date.now() - parseInt(pcd.claim.watermark) > ONE_HOUR_MS * 4) {
        return {
          success: true,
          value: {
            verified: false,
            message: "PCD watermark has expired."
          }
        };
      }

      eventId = pcd.claim.partialTicket.eventId;
      productId = pcd.claim.partialTicket.productId;
      publicKey = pcd.claim.signer;
    }

    const knownTicketType = await fetchKnownTicketByEventAndProductId(
      this.context.dbPool,
      eventId,
      productId
    );

    // If we found a known ticket type, compare public keys
    if (
      knownTicketType &&
      isEqualEdDSAPublicKey(JSON.parse(knownTicketType.public_key), publicKey)
    ) {
      // We can say that the submitted ticket can be verified as belonging
      // to a known group
      return {
        success: true,
        value: {
          verified: true,
          publicKeyName: knownTicketType.known_public_key_name,
          group: knownTicketType.ticket_group
        }
      };
    } else {
      return {
        success: true,
        value: {
          verified: false,
          message: "Not a valid ticket"
        }
      };
    }
  }

  private async verifyZuconnect23OrZuzalu23TicketById(
    ticketId: string,
    timestamp: string
  ): Promise<VerifyTicketByIdResult> {
    if (Date.now() - parseInt(timestamp) > ONE_HOUR_MS * 4) {
      return {
        success: true,
        value: {
          verified: false,
          message: "Timestamp has expired."
        }
      };
    }

    const zuconnectTicket = await fetchZuconnectTicketById(
      this.context.dbPool,
      ticketId
    );

    if (zuconnectTicket) {
      return {
        success: true,
        value: {
          verified: true,
          group: KnownTicketGroup.Zuconnect23,
          publicKeyName: ZUPASS_TICKET_PUBLIC_KEY_NAME,
          productId: zuconnectTicket.product_id,
          ticketName:
            zuconnectTicket.product_id === ZUCONNECT_23_DAY_PASS_PRODUCT_ID
              ? zuconnectTicket.extra_info.join("\n")
              : zuconnectProductIdToName(zuconnectTicket.product_id)
        }
      };
    } else {
      const zuzaluTicket = await fetchLoggedInZuzaluUser(this.context.dbPool, {
        uuid: ticketId
      });

      if (zuzaluTicket) {
        return {
          success: true,
          value: {
            verified: true,
            group: KnownTicketGroup.Zuzalu23,
            publicKeyName: ZUPASS_TICKET_PUBLIC_KEY_NAME,
            productId:
              zuzaluTicket.role === ZuzaluUserRole.Visitor
                ? ZUZALU_23_VISITOR_PRODUCT_ID
                : zuzaluTicket.role === ZuzaluUserRole.Organizer
                ? ZUZALU_23_ORGANIZER_PRODUCT_ID
                : ZUZALU_23_RESIDENT_PRODUCT_ID,
            ticketName: undefined
          }
        };
      }
    }

    return {
      success: false,
      error: "Could not verify ticket."
    };
  }

  public async handleVerifyTicketRequest(
    req: VerifyTicketRequest
  ): Promise<VerifyTicketResult> {
    const pcdStr = req.pcd;

    try {
      return this.verifyZuconnect23OrZuzalu23Ticket(JSON.parse(pcdStr));
    } catch (e) {
      throw new PCDHTTPError(500, "The ticket could not be verified", {
        cause: e
      });
    }
  }

  public async handleVerifyTicketByIdRequest(
    req: VerifyTicketByIdRequest
  ): Promise<VerifyTicketByIdResult> {
    return this.verifyZuconnect23OrZuzalu23TicketById(
      req.ticketId,
      req.timestamp
    );
  }

  /**
   * Returns information about the known public keys, and known ticket types.
   * This is used by clients to perform basic checks of validity against
   * ticket PCDs, based on the public key and ticket/event IDs.
   */
  public async handleKnownTicketTypesRequest(): Promise<KnownTicketTypesResult> {
    const knownTickets = await fetchKnownTicketTypes(this.context.dbPool);
    const knownPublicKeys = await fetchKnownPublicKeys(this.context.dbPool);
    return {
      success: true,
      value: {
        publicKeys: knownPublicKeys.map((pk) => {
          return {
            publicKey:
              pk.public_key_type === "eddsa"
                ? JSON.parse(pk.public_key)
                : pk.public_key,
            publicKeyName: pk.public_key_name,
            publicKeyType: pk.public_key_type
          };
        }),
        knownTicketTypes: knownTickets.map((tt) => {
          return {
            eventId: tt.event_id,
            productId: tt.product_id,
            publicKey:
              tt.known_public_key_type === "eddsa"
                ? JSON.parse(tt.public_key)
                : tt.public_key,
            publicKeyName: tt.known_public_key_name,
            publicKeyType: tt.known_public_key_type,
            ticketGroup: tt.ticket_group
          };
        })
      }
    };
  }

  public async handleGetOfflineTickets(
    req: GetOfflineTicketsRequest,
    res: Response
  ): Promise<void> {
    const signaturePCD = await SemaphoreSignaturePCDPackage.deserialize(
      req.checkerProof.pcd
    );
    const valid = await this.cachedVerifySignaturePCD(req.checkerProof);
    if (!valid) {
      throw new PCDHTTPError(403, "invalid proof");
    }

    const offlineTickets = await fetchOfflineTicketsForChecker(
      this.context.dbPool,
      signaturePCD.claim.identityCommitment
    );

    res.json({
      offlineTickets
    } satisfies GetOfflineTicketsResponseValue);
  }

  public async handleUploadOfflineCheckins(
    req: UploadOfflineCheckinsRequest,
    res: Response
  ): Promise<void> {
    const signaturePCD = await SemaphoreSignaturePCDPackage.deserialize(
      req.checkerProof.pcd
    );
    const valid = await this.cachedVerifySignaturePCD(req.checkerProof);

    if (!valid) {
      throw new PCDHTTPError(403, "invalid proof");
    }

    await checkInOfflineTickets(
      this.context.dbPool,
      signaturePCD.claim.identityCommitment,
      req.checkedOfflineInDevconnectTicketIDs
    );

    res.json({} satisfies UploadOfflineCheckinsResponseValue);
  }
}

export async function startIssuanceService(
  context: ApplicationContext,
  cacheService: PersistentCacheService,
  rollbarService: RollbarService | null,
  multiprocessService: MultiProcessService
): Promise<IssuanceService | null> {
  const zupassRsaKey = loadRSAPrivateKey();
  const zupassEddsaKey = loadEdDSAPrivateKey();

  if (zupassRsaKey == null || zupassEddsaKey == null) {
    logger("[INIT] can't start issuance service, missing private key");
    return null;
  }

  await setupKnownTicketTypes(
    context.dbPool,
    await getEdDSAPublicKey(zupassEddsaKey)
  );

  const issuanceService = new IssuanceService(
    context,
    cacheService,
    multiprocessService,
    rollbarService,
    zupassRsaKey,
    zupassEddsaKey
  );

  return issuanceService;
}

/**
 * The issuance service relies on a list of known ticket types, and their
 * associated public keys. This relies on having these stored in the database,
 * and we can ensure that certain known public keys and tickets are stored by
 * inserting them here.
 *
 * This works because we know the key we're using to issue tickets, and we
 * have some hard-coded IDs for Zuzalu '23 tickets.
 *
 * See {@link verifyTicket} and {@link handleKnownTicketTypesRequest} for
 * usage of this data.
 *
 * See also {@link setDevconnectTicketTypes} in the Devconnect sync service.
 */
async function setupKnownTicketTypes(
  db: Pool,
  eddsaPubKey: EdDSAPublicKey
): Promise<void> {
  await setKnownPublicKey(
    db,
    ZUPASS_TICKET_PUBLIC_KEY_NAME,
    KnownPublicKeyType.EdDSA,
    JSON.stringify(eddsaPubKey)
  );

  await setKnownTicketType(
    db,
    "ZUZALU23_VISITOR",
    ZUZALU_23_EVENT_ID,
    ZUZALU_23_VISITOR_PRODUCT_ID,
    ZUPASS_TICKET_PUBLIC_KEY_NAME,
    KnownPublicKeyType.EdDSA,
    KnownTicketGroup.Zuzalu23
  );

  await setKnownTicketType(
    db,
    "ZUZALU23_RESIDENT",
    ZUZALU_23_EVENT_ID,
    ZUZALU_23_RESIDENT_PRODUCT_ID,
    ZUPASS_TICKET_PUBLIC_KEY_NAME,
    KnownPublicKeyType.EdDSA,
    KnownTicketGroup.Zuzalu23
  );

  await setKnownTicketType(
    db,
    "ZUZALU23_ORGANIZER",
    ZUZALU_23_EVENT_ID,
    ZUZALU_23_ORGANIZER_PRODUCT_ID,
    ZUPASS_TICKET_PUBLIC_KEY_NAME,
    KnownPublicKeyType.EdDSA,
    KnownTicketGroup.Zuzalu23
  );

  // Store Zuconnect ticket types
  for (const { id, eventId } of Object.values(ZUCONNECT_PRODUCT_ID_MAPPINGS)) {
    setKnownTicketType(
      db,
      `zuconnect-${id}`,
      eventId,
      id,
      ZUPASS_TICKET_PUBLIC_KEY_NAME,
      KnownPublicKeyType.EdDSA,
      KnownTicketGroup.Zuconnect23
    );
  }
}

function loadRSAPrivateKey(): NodeRSA | null {
  const pkeyEnv = process.env.SERVER_RSA_PRIVATE_KEY_BASE64;

  if (pkeyEnv == null) {
    logger("[INIT] missing environment variable SERVER_RSA_PRIVATE_KEY_BASE64");
    return null;
  }

  try {
    const key = new NodeRSA(
      Buffer.from(pkeyEnv, "base64").toString("utf-8"),
      "private"
    );
    return key;
  } catch (e) {
    logger("failed to parse RSA private key", e);
  }

  return null;
}

function loadEdDSAPrivateKey(): string | null {
  const pkeyEnv = process.env.SERVER_EDDSA_PRIVATE_KEY;

  if (pkeyEnv == null) {
    logger("[INIT] missing environment variable SERVER_EDDSA_PRIVATE_KEY");
    return null;
  }

  return pkeyEnv;
}
