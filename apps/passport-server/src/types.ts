import { Application } from "express";
import * as http from "http";
import Libhoney from "libhoney";
import { Pool } from "postgres-pool";
import { IEmailAPI } from "./apis/emailAPI";
import { IZuconnectTripshaAPI } from "./apis/zuconnect/zuconnectTripshaAPI";
import { IZuzaluPretixAPI } from "./apis/zuzaluPretixAPI";
import {
  DevconnectPretixAPIFactory,
  DevconnectPretixSyncService
} from "./services/devconnectPretixSyncService";
import { DiscordService } from "./services/discordService";
import { E2EEService } from "./services/e2eeService";
import { EmailTokenService } from "./services/emailTokenService";
import { FrogcryptoService } from "./services/frogcryptoService";
import { IssuanceService } from "./services/issuanceService";
import { KudosbotService } from "./services/kudosbotService";
import { MetricsService } from "./services/metricsService";
import { MultiProcessService } from "./services/multiProcessService";
import { PersistentCacheService } from "./services/persistentCacheService";
import { ProvingService } from "./services/provingService";
import { RollbarService } from "./services/rollbarService";
import { SemaphoreService } from "./services/semaphoreService";
import { TelegramService } from "./services/telegramService";
import { UserService } from "./services/userService";
import { ZuconnectTripshaSyncService } from "./services/zuconnectTripshaSyncService";
import { ZuzaluPretixSyncService } from "./services/zuzaluPretixSyncService";

export interface ApplicationContext {
  dbPool: Pool;
  honeyClient: Libhoney | null;
  resourcesDir: string;
  publicResourcesDir: string;
  gitCommitHash: string;
}

export interface GlobalServices {
  semaphoreService: SemaphoreService;
  userService: UserService;
  e2eeService: E2EEService;
  emailTokenService: EmailTokenService;
  rollbarService: RollbarService | null;
  provingService: ProvingService;
  zuzaluPretixSyncService: ZuzaluPretixSyncService | null;
  devconnectPretixSyncService: DevconnectPretixSyncService | null;
  zuconnectTripshaSyncService: ZuconnectTripshaSyncService | null;
  metricsService: MetricsService;
  issuanceService: IssuanceService | null;
  discordService: DiscordService | null;
  telegramService: TelegramService | null;
  kudosbotService: KudosbotService | null;
  frogcryptoService: FrogcryptoService | null;
  persistentCacheService: PersistentCacheService;
  multiprocessService: MultiProcessService;
}

export interface Zupass {
  context: ApplicationContext;
  services: GlobalServices;
  apis: APIs;
  expressContext: {
    app: Application;
    server: http.Server;
    localEndpoint: string;
  };
}

export interface APIs {
  emailAPI: IEmailAPI | null;
  zuzaluPretixAPI: IZuzaluPretixAPI | null;
  devconnectPretixAPIFactory: DevconnectPretixAPIFactory | null;
  zuconnectTripshaAPI: IZuconnectTripshaAPI | null;
}

export interface EnvironmentVariables {
  MAILGUN_API_KEY?: string;
  DATABASE_USERNAME?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_HOST?: string;
  DATABASE_DB_NAME?: string;
  DATABASE_SSL?: string;
  BYPASS_EMAIL_REGISTRATION?: string;
  NODE_ENV?: string;
  HONEYCOMB_API_KEY?: string;
  PRETIX_TOKEN?: string;
  PRETIX_ORG_URL?: string;
  PRETIX_ZU_EVENT_ID?: string;
  PRETIX_VISITOR_EVENT_ID?: string;
  ROLLBAR_TOKEN?: string;
  SUPPRESS_LOGGING?: string;
  SERVER_EDDSA_PRIVATE_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_PRIVATE_CHAT_ID?: string;
  PASSPORT_CLIENT_URL?: string;
  ACCOUNT_RESET_RATE_LIMIT_DISABLED?: string;
  ACCOUNT_RESET_LIMIT_QUANTITY?: string;
  ACCOUNT_RESET_LIMIT_DURATION_MS?: string;
  TELEGRAM_KUDOSBOT_TOKEN?: string;
  FROG_OWNERS_TELEGRAM_CHAT_ID?: string;
}
