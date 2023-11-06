import {
  FrogCryptoDeleteFrogsRequest,
  FrogCryptoDeleteFrogsResponseValue,
  FrogCryptoUpdateFeedsRequest,
  FrogCryptoUpdateFeedsResponseValue,
  FrogCryptoUpdateFrogsRequest,
  FrogCryptoUpdateFrogsResponseValue,
  FrogCryptoUserStateRequest,
  FrogCryptoUserStateResponseValue,
  ListFeedsResponseValue,
  PollFeedRequest,
  PollFeedResponseValue
} from "@pcd/passport-interface";
import express, { Request, Response } from "express";
import request from "request";
import urljoin from "url-join";
import { FrogcryptoService } from "../../services/frogcryptoService";
import { ApplicationContext, GlobalServices } from "../../types";
import { logger } from "../../util/logger";
import { checkUrlParam } from "../params";
import { PCDHTTPError } from "../pcdHttpError";

export function initFrogcryptoRoutes(
  app: express.Application,
  _context: ApplicationContext,
  { frogcryptoService }: GlobalServices
): void {
  logger("[INIT] initializing frogcrypto routes");

  /**
   * Throws if we don't have an instance of {@link frogcryptoService}.
   */
  function checkFrogcryptoServiceStarted(
    frogcryptoService: FrogcryptoService | null
  ): asserts frogcryptoService {
    if (!frogcryptoService) {
      throw new PCDHTTPError(503, "issuance service not instantiated");
    }
  }

  /**
   * Lets a Zupass client (or even a 3rd-party-developed client get PCDs from a
   * particular feed that this server is hosting.
   */
  app.get("/frogcrypto/feeds", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.handleListFeedsRequest(
      req.body as PollFeedRequest
    );
    res.json(result satisfies ListFeedsResponseValue);
  });

  /**
   * Lets a Zupass client (or even a 3rd-party-developed client get PCDs from a
   * particular feed that this server is hosting.
   */
  app.post("/frogcrypto/feeds", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.handleFeedRequest(
      req.body as PollFeedRequest
    );
    res.json(result satisfies PollFeedResponseValue);
  });

  app.get("/frogcrypto/feeds/:feedId", async (req: Request, res: Response) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const feedId = checkUrlParam(req, "feedId");
    if (!frogcryptoService.hasFeedWithId(feedId)) {
      throw new PCDHTTPError(404);
    }
    res.json(await frogcryptoService.handleListSingleFeedRequest({ feedId }));
  });

  app.get("/frogcrypto/scoreboard", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.getScoreboard();
    res.json(result);
  });

  app.post("/frogcrypto/user-state", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.getUserState(
      req.body as FrogCryptoUserStateRequest
    );
    res.json(result satisfies FrogCryptoUserStateResponseValue);
  });

  app.get("/frogcrypto/images/:uuid", async (req, res) => {
    const imageId = checkUrlParam(req, "uuid");

    if (!process.env.FROGCRYPTO_ASSETS_URL) {
      throw new PCDHTTPError(503, "FrogCrypto Assets Unavailable");
    }

    req
      .pipe(
        request(
          urljoin(process.env.FROGCRYPTO_ASSETS_URL, `${imageId}.png`)
        ).on("error", (err) => {
          logger(`[FrogCrypto] Error fetching FrogCrypto Assets: ${err}`);
          throw new PCDHTTPError(503, "FrogCrypto Assets Unavailable");
        })
      )
      .pipe(res);
  });

  app.post("/frogcrypto/admin/frogs", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.updateFrogData(
      req.body as FrogCryptoUpdateFrogsRequest
    );
    res.json(result satisfies FrogCryptoUpdateFrogsResponseValue);
  });

  app.post("/frogcrypto/admin/delete-frogs", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.deleteFrogData(
      req.body as FrogCryptoDeleteFrogsRequest
    );
    res.json(result satisfies FrogCryptoDeleteFrogsResponseValue);
  });

  app.post("/frogcrypto/admin/feeds", async (req, res) => {
    checkFrogcryptoServiceStarted(frogcryptoService);
    const result = await frogcryptoService.updateFeedData(
      req.body as FrogCryptoUpdateFeedsRequest
    );
    res.json(result satisfies FrogCryptoUpdateFeedsResponseValue);
  });
}
