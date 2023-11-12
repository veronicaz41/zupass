import { EdDSAPublicKey } from "@pcd/eddsa-pcd";
import { EdDSATicketPCD } from "@pcd/eddsa-ticket-pcd";
import { PCDAction } from "@pcd/pcd-collection";
import { ArgsOf, PCDOf, PCDPackage, SerializedPCD } from "@pcd/pcd-types";
import { SemaphoreSignaturePCD } from "@pcd/semaphore-signature-pcd";
import {
  DexFrog,
  FrogCryptoDbFeedData,
  FrogCryptoFrogData,
  FrogCryptoScore
} from "./FrogCrypto";
import { PendingPCDStatus } from "./PendingPCDUtils";
import { Feed } from "./SubscriptionManager";
import { NamedAPIError } from "./api/apiResult";

/**
 * Ask the server to prove a PCD. The server reponds with a {@link PendingPCD}
 */
export interface ServerProofRequest<T extends PCDPackage = PCDPackage> {
  pcdType: string;
  args: ArgsOf<T>;
}

/**
 * Ask the server for the status of a queued server-side proof.
 */
export interface ProofStatusRequest {
  hash: string;
}

/**
 * The server's response to a {@link ProofStatusRequest}.
 */
export interface ProofStatusResponseValue {
  status: PendingPCDStatus;

  /**
   * If status === COMPLETE, JSON.stringify(SerializedPCD), else undefined
   */
  serializedPCD: string | undefined;

  /**
   * If status === ERROR, error string from server, else undefined;
   */
  error: string | undefined;
}

/**
 * Ask the server what sorts of proofs it's able to instantiate for users.
 */
export interface SupportedPCDsResponseValue {
  names: string[];
}

/**
 * Ask the server to save e2ee a user's PCDs and other metadata.
 */
export interface UploadEncryptedStorageRequest {
  /**
   * On the server-side, encrypted storage is keyed by the hash of
   * the user's encryption key.
   */
  blobKey: string;

  /**
   * An encrypted and stringified version of {@link EncryptedStorage}
   */
  encryptedBlob: string;

  /**
   * Optional field allowing the client to detect and avoid conflicting
   * updates.
   *
   * If specified, this is the previous revision of stored data which the
   * client is aware of and has included in its updates.  If this does not match
   * the latest revision available on the server, the request will fail without
   * making any changes.
   *
   * If this field is absent, the new blob is always saved, overwriting any
   * existing revision.
   */
  knownRevision?: string;
}

/**
 * Response to {@link UploadEncryptedStorageRequest}
 */
export interface UploadEncryptedStorageResponseValue {
  /**
   * The revision assigned to identify the stored blob.  Revision is assigned by
   * the server and can be used later to identify this blob and avoid conflicts.
   */
  revision: string;
}

/**
 * Ask the server for an e2ee backup of a user's data given a `blobKey`.
 */
export interface DownloadEncryptedStorageRequest {
  /**
   * On the server-side, encrypted storage is keyed by the hash of
   * the encryption key.
   */
  blobKey: string;

  /**
   * Optional field indicating the revision of the latest blob already known to
   * the client.  If this matches the latest blob stored on the server, the
   * request will succeed, but the result will not contain any blob.
   */
  knownRevision?: string;
}

/**
 * Response to {@link DownloadEncryptedStorageRequest}
 */
export interface DownloadEncryptedStorageResponseValue {
  /**
   * The retrieved blob for the given key.  This will be absent if the request
   * included a `knownRevision` which matched the latest revision.
   */
  encryptedBlob?: string;

  /**
   * The revision identifying this blob on the server.  Revision is assigned by
   * the server and can be used later to identify this blob and avoid conflicts.
   */
  revision: string;
}

/**
 * Ask the server to change the salt, delete the storage at the old blob key,
 * and add a new encrypted storage entry encrypted with the new blob key.
 */
export interface ChangeBlobKeyRequest {
  /**
   * The original hashed encryption key to be deleted.
   */
  oldBlobKey: string;

  /**
   * The new hashed encryption key to be added.
   */
  newBlobKey: string;

  /**
   * UUID of the user making the request.
   */
  uuid: string;

  /**
   * The salt used in generating the new blob key.
   */
  newSalt: string;

  /**
   * The encrypted and stringified version of {@link EncryptedStorage} to save
   */
  encryptedBlob: string;

  /**
   * Optional field allowing the client to detect and avoid conflicting
   * updates.
   *
   * If specified, this is the previous revision of stored data which the
   * client is aware of and has included in its updates.  If this does not match
   * the latest revision available on the server, the request will fail without
   * making any changes.
   *
   * If this field is absent, the new blob is always saved, overwriting any
   * existing revision.
   */
  knownRevision?: string;
}

/**
 * Response to {@link ChangeBlobKeyRequest}
 */
export interface ChangeBlobKeyResponseValue {
  /**
   * The revision assigned to identify the stored blob.  Revision is assigned by
   * the server and can be used later to identify this blob and avoid conflicts.
   */
  revision: string;
}

/**
 * A {@link ChangeBlobKeyRequest} can fail with a few non-standard named errors:
 * PasswordIncorrect if there is no blob for the given key
 * UserNotFound if the user does not exist
 * RequiresNewSalt if the given salt is the same as the old salt
 * Conflict if knownRevision is specified and doesn't match
 */
export type ChangeBlobKeyError = NamedAPIError;

/**
 * Ask the server to check whether this ticket is still eligible to be checked in.
 */
export interface CheckTicketRequest {
  ticket: SerializedPCD<EdDSATicketPCD>;
  signature: SerializedPCD<SemaphoreSignaturePCD>;
}

/**
 * Happy-path the server has nothing to say in response to a {@link CheckTicketRequest}
 */
export type CheckTicketReponseValue = undefined;

/**
 * Ask the server to check whether this ticket is still eligible to be checked
 * in, after looking it up by ticket ID.
 */
export interface CheckTicketByIdRequest {
  ticketId: string;
  signature: SerializedPCD<SemaphoreSignaturePCD>;
}

/**
 * Response to a {@link CheckTicketByIdRequest} is a subset of {@link ITicketData}
 * required for DevconnectCheckinByIdScreen.tsx
 */
export type CheckTicketByIdResponseValue = {
  attendeeName: string;
  attendeeEmail: string;
  eventName: string;
  ticketName: string;
};

/**
 * However, many problems can come up in {@link CheckTicketRequest}
 * and {@link CheckTicketByIdRequest}. This type enumerates all the possible
 * problems.
 */
export type TicketError = { detailedMessage?: string } & (
  | { name: "NotSuperuser" }
  | {
      name: "AlreadyCheckedIn";
      checkinTimestamp: string | undefined;
      checker: string | undefined;
    }
  | { name: "InvalidSignature" }
  | { name: "InvalidTicket" }
  | { name: "TicketRevoked"; revokedTimestamp: number }
  | { name: "NetworkError" }
  | { name: "ServerError" }
);

/**
 * A particular 'superuser' ticket-holder can request to check in
 * another ticket that belongs to the same event.
 */
export interface CheckTicketInRequest {
  /**
   * A semaphore signature from the checker, used by the server to
   * determine whether the checker has the required permissions
   * to check this ticket in.
   */
  checkerProof: SerializedPCD<SemaphoreSignaturePCD>;

  /**
   * The ticket to attempt to check in.
   */
  ticket: SerializedPCD<EdDSATicketPCD>;
}

/**
 * On the happy path, {@link CheckTicketInRequest} has nothing to say and
 * just succeeds.
 */
export type CheckTicketInResponseValue = undefined;

/**
 * A {@link CheckTicketInRequest} can fail for a number of reasons.
 */
export type CheckTicketInError = TicketError;

/**
 * A particular 'superuser' ticket-holder can request to check in
 * another ticket that belongs to the same event, by referencing the ID
 * of the ticket.
 */
export interface CheckTicketInByIdRequest {
  /**
   * A semaphore signature from the checker, used by the server to
   * determine whether the checker has the required permissions
   * to check this ticket in.
   */
  checkerProof: SerializedPCD<SemaphoreSignaturePCD>;

  /**
   * The ticket ID to attempt to check in.
   */
  ticketId: string;
}

/**
 * Ask the server for tickets relevant to this user for offline storage,
 * so that offline verification and checkin can work on the client.
 */
export interface GetOfflineTicketsRequest {
  /**
   * A semaphore signature from the checker, used by the server to
   * determine which tickets should be returned.
   */
  checkerProof: SerializedPCD<SemaphoreSignaturePCD>;
}

/**
 * Result value server sends client in response to a {@link GetOfflineTicketsRequest}.
 */
export interface GetOfflineTicketsResponseValue {
  /**
   * Collection of tickets the client should save to localstorage so that
   * they work offline.
   */
  offlineTickets: OfflineTickets;
}

/**
 * Asks the server to checkin the given tickets. Only affects valid
 * un-checked-in tickets check-in-able by the given user. Silently
 * skips tickets the given user can't check in for any reason.
 */
export interface UploadOfflineCheckinsRequest {
  /**
   * A semaphore signature from the checker, used by the server to
   * determine which tickets can actually be checked in.
   */
  checkerProof: SerializedPCD<SemaphoreSignaturePCD>;

  /**
   * List of ticket ids to attempt to check in.
   */
  checkedOfflineInDevconnectTicketIDs: string[];
}

/**
 * Server gives no feedback in response to a {@link UploadOfflineCheckinsRequest}.
 * That request only fails in the case of a network error, internal server error,
 * and the like.
 */
export interface UploadOfflineCheckinsResponseValue {}

/**
 * On the happy path, {@link CheckTicketInByIdRequest} has nothing to say and
 * just succeeds.
 */
export type CheckTicketInByIdResponseValue = undefined;

/**
 * A {@link CheckTicketInByIdRequest} can fail for a number of reasons.
 */
export type CheckTicketInByIdError = TicketError;

/**
 * When verifying scanned PCDs, we want to check with the server, which
 * knows about public keys when the client does not.
 */
export interface VerifyTicketRequest {
  /**
   * A PCD to verify. JSON-encoded {@link SerializedPCD}.
   */
  pcd: string;
}

/**
 * Supported ticket groups for known tickets. This is based on pattern-matching
 * of event ID, product ID, and signing key.
 */
export const enum KnownTicketGroup {
  Devconnect23 = "Devconnect23",
  Zuzalu23 = "Zuzalu23",
  Zuconnect23 = "Zuconnect23"
}

/**
 * Result of verification, and name of the public key if recognized.
 */
export type VerifyTicketResponseValue =
  | {
      verified: true;
      publicKeyName: string;
      group: KnownTicketGroup;
    }
  | {
      verified: false;
      message?: string;
    };

/**
 * Verifies a ticket by ticket ID and timestamp.
 * See also {@link VerifyTicketRequest}
 */
export interface VerifyTicketByIdRequest {
  /**
   * The ID of an EdDSATicketPCD.
   */
  ticketId: string;
  /**
   * A timestamp, in milliseconds since midnight January 1 1970.
   */
  timestamp: string;
}

export type VerifyTicketByIdResponseValue =
  | {
      verified: true;
      publicKeyName: string;
      group: KnownTicketGroup;
      productId: string;
      ticketName?: string;
    }
  | {
      verified: false;
      message?: string;
    };

/**
 * Ask the Zupass server, or a 3rd party server to return the list of feeds
 * that it is hosting.
 */
export type ListFeedsRequest = unknown;

/**
 * Response to {@link ListFeedsRequest}.
 */
export interface ListFeedsResponseValue {
  providerUrl: string;
  providerName: string;
  feeds: Feed[];
}

export interface ListSingleFeedRequest {
  feedId: string;
}

/**
 * Ask the Zupass server, or a 3rd party server, to give the user
 * some PCDs, given the particular feed and credential that the
 * user supplies.
 */
export interface PollFeedRequest<T extends PCDPackage = PCDPackage> {
  feedId: string;
  pcd?: SerializedPCD<PCDOf<T>>;
}

/**
 * Response to {@link PollFeedRequest}.
 */
export interface PollFeedResponseValue {
  actions: PCDAction[];
}

/**
 * The Zupass server returns this data structure to users
 * to represent Zupass users.
 */
export interface ZupassUserJson {
  uuid: string;
  commitment: string;
  email: string;
  salt: string | null;
  terms_agreed: number;
}

/**
 * Ask the Zupass server to send a confirmation email with a
 * log-in token to the given email.
 */
export type ConfirmEmailRequest = {
  /**
   * Each email can have one account on Zupass.
   */
  email: string;

  /**
   * Public semaphore commitment of this user. The server never learns
   * the user's private semaphore details.
   */
  commitment: string;

  /**
   * Whether or not to overwrite an existing user, if one is present.
   * Required to be 'true' if a user with the same email already exists.
   */
  force: "true" | "false";
};

/**
 * Response to {@link ConfirmEmailRequest}
 */
export type ConfirmEmailResponseValue =
  | {
      /**
       * In development mode, the server can return a token
       * to the client rather than sending it via an email,
       * speeding up software development iteration. Check
       * out the `BYPASS_EMAIL_REGISTRATION` environment variable
       * elsewhere in this codebase to learn more.
       */
      devToken: string;
    }
  | undefined;

/**
 * Ask the Zupass server for the salt of a particular user.
 */
export type SaltRequest = { email: string };

/**
 * Response to {@link SaltRequest}.
 */
export type SaltResponseValue = string | null;

/**
 * Ask the server to let us know if the given token is valid and
 * OK to use for logging in / overwriting an existing account.
 */
export type VerifyTokenRequest = {
  email: string;
  token: string;
};

/**
 * Returns the encryption_key of the account, if the user has opted to not set
 * a password and store their encryption key on our server.
 * {@link VerifyTokenRequest}.
 */
export type VerifyTokenResponseValue = { encryptionKey: string | null };

/**
 * Ask the server to log us in using a special login flow designed
 * for use by the coworking space organizers.
 */
export type DeviceLoginRequest = {
  email: string;
  secret: string;
  commitment: string;
};

/**
 * Ask the Zupass server to create a new account with
 * the given details, overwriting an existing account if one is
 * present.
 */
export type CreateNewUserRequest = {
  email: string;
  token: string;
  commitment: string;
  /**
   * Zupass users don't have a salt.
   */
  salt: string | undefined;
  encryptionKey: string | undefined;
};

/**
 * Zupass responds with this when you ask it if it is able to
 * issue tickets. Used primarily for testing.
 */
export type IssuanceEnabledResponseValue = boolean;

/**
 * Zupass responds with this when you ask it whether it has
 * synced the Zuzalu users yet.
 */
export type PretixSyncStatusResponseValue = string;

/**
 * In the case that loading an existing Zupass user fails,
 * we can determine if it failed because the user does not exist,
 * or due to some other error, such as intermittent network error,
 * or the backend being down.
 */
export type LoadUserError =
  | { userMissing: true; errorMessage?: never }
  | { userMissing?: never; errorMessage: string };

/**
 * When you ask Zupass for a user, it will respond with this type.
 */
export type UserResponseValue = ZupassUserJson;

/**
 * Zupass responds with this when you ask it if it knows of a given
 * (id, rootHash) tuple.
 */
export type SemaphoreValidRootResponseValue = { valid: boolean };

/**
 * For known tickets, this is the type of the public key.
 * Possibly this information is redundant, but it seems useful to be
 * explicit about the type of key used.
 */
export const enum KnownPublicKeyType {
  EdDSA = "eddsa",
  RSA = "rsa"
}

/**
 * Known ticket types, describing the attributes of a ticket that
 * belongs to a group.
 */
export interface KnownTicketType {
  eventId: string;
  productId: string;
  publicKey: EdDSAPublicKey;
  publicKeyName: string;
  publicKeyType: KnownPublicKeyType;
  ticketGroup: KnownTicketGroup;
}

/**
 * Known public keys, with a name and type to enable them to be
 * identified in relation to known ticket types.
 */
export type KnownPublicKey =
  | {
      publicKeyName: string;
      publicKeyType: "eddsa";
      publicKey: EdDSAPublicKey;
    }
  | {
      publicKeyName: string;
      publicKeyType: "rsa";
      publicKey: string;
    };

export interface KnownTicketTypesAndKeys {
  knownTicketTypes: KnownTicketType[];
  publicKeys: KnownPublicKey[];
}

/**
 * Zupass responds with this when you ask it for the details of known
 * ticket types.
 */
export type KnownTicketTypesResponseValue = KnownTicketTypesAndKeys;

export type KnownTicketTypesRequest = undefined;

/**
 * The version of the legal terms being agreed to.
 */
export interface AgreeTermsPayload {
  version: number;
}

/**
 * When a user agrees to new legal terms, they send us a signed proof.
 */
export interface AgreeTermsRequest {
  pcd: SerializedPCD<SemaphoreSignaturePCD>;
}

/**
 * After the user agrees to the terms, respond with the terms version recorded.
 */
export interface AgreeToTermsResponseValue {
  version: number;
}

/**
 * The string the client must sign with the user's semaphore identity
 * in order to be able to request the PCDs that the server wants to
 * issue the user.
 */
export const ISSUANCE_STRING = "Issue me PCDs please.";

/**
 * Collection of tickets that some clients keep track of so that the tickets
 * contained within it function offline.
 */
export interface OfflineTickets {
  devconnectTickets: OfflineDevconnectTicket[];
}

/**
 * New empty {@link OfflineTickets}.
 */
export function defaultOfflineTickets(): OfflineTickets {
  return {
    devconnectTickets: []
  };
}

/**
 * Shown to checkers with valid permissions when they are in offline mode.
 */
export interface OfflineDevconnectTicket {
  id: string;
  attendeeEmail: string;
  attendeeName: string;
  eventName: string;
  ticketName: string;
  checkinTimestamp?: string;
  checker: string | null;
  is_consumed?: boolean;
}

/**
 * User requests about
 * 1. for the feeds they are subscribed to, when they can get next frog and
 *    whether it is active
 * 2. how many frogs in Frogedex
 *
 * NB: The number of possible frogs are currently not user specific. It is
 * possible that we will introduce series unlock in the future where the number
 * of possible frogs will be user specific.
 */
export interface FrogCryptoUserStateRequest {
  pcd: SerializedPCD<SemaphoreSignaturePCD>;
  feedIds: string[];
}

/**
 * Individual feed level response to {@link FrogCryptoUserStateRequest}
 */
export interface FrogCryptoComputedUserState {
  feedId: string;
  lastFetchedAt: number;
  nextFetchAt: number;
  active: boolean;
}

/**
 * Response to {@link FrogCryptoUserStateRequest}
 */
export interface FrogCryptoUserStateResponseValue {
  feeds: FrogCryptoComputedUserState[];
  /**
   * A list of possible frogs
   */
  possibleFrogs: DexFrog[];
  myScore?: FrogCryptoScore;
}

/**
 * Admin request to manage frogs in the databse.
 */
export type FrogCryptoUpdateFrogsRequest = {
  pcd: SerializedPCD<SemaphoreSignaturePCD>;
  /**
   * Pass empty array for no-op and return all frogs.
   */
  frogs: FrogCryptoFrogData[];
};

/**
 * Response to {@link FrogCryptoUpdateFrogsRequest} and returns all frogs.
 */
export interface FrogCryptoUpdateFrogsResponseValue {
  frogs: FrogCryptoFrogData[];
}

/**
 * Admin request to delete frogs in the databse.
 */
export type FrogCryptoDeleteFrogsRequest = {
  pcd: SerializedPCD<SemaphoreSignaturePCD>;
  frogIds: number[];
};

/**
 * Response to {@link FrogCryptoDeleteFrogsRequest} and returns all remaining frogs.
 */
export interface FrogCryptoDeleteFrogsResponseValue {
  frogs: FrogCryptoFrogData[];
}

/**
 * Admin request to manage feeds in the databse.
 */
export type FrogCryptoUpdateFeedsRequest = {
  pcd: SerializedPCD<SemaphoreSignaturePCD>;
  /**
   * Pass empty array for no-op and return all feeds.
   */
  feeds: FrogCryptoDbFeedData[];
};

/**
 * Response to {@link FrogCryptoUpdateFeedsRequest} and returns all feeds.
 */
export interface FrogCryptoUpdateFeedsResponseValue {
  feeds: FrogCryptoDbFeedData[];
}
