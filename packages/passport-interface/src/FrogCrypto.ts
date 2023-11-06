import { Biome, EdDSAFrogPCDPackage } from "@pcd/eddsa-frog-pcd";
import _ from "lodash";
import { z } from "zod";
import { Feed } from "./SubscriptionManager";

/**
 * Map of configs for Biome(s) where PCDs can be issued from this feed
 */
export const FrogCryptoFeedBiomeConfigSchema = z.object({
  /**
   * A scaling factor that is multiplied to the weight of the frog to affect
   * the probability of the frog being issued
   *
   * For example, if a feed has 3 frogs:
   *
   * * JungleFrog1's drop weight is 1
   * * JungleFrog2's drop weight is 2
   * * DesertFrog3's drop weight is 3
   *
   *  If the Jungle's dropWeightScaler is 2 and the Desert's
   *   dropWeightScaler is 1, then
   *
   * * JungleFrog1's probability of being issued is 2/9
   * * JungleFrog2's probability of being issued is 4/9
   * * DesertFrog3's probability of being issued is 3/9
   */
  dropWeightScaler: z.number().nonnegative()
});

export const FrogCryptoFeedBiomeConfigsSchema = z.object(
  _.mapValues(Biome, () => FrogCryptoFeedBiomeConfigSchema.optional())
);

export type FrogCryptoFeedBiomeConfigs = z.infer<
  typeof FrogCryptoFeedBiomeConfigsSchema
>;

/**
 * Schema for FrogCrypto specific feed interface
 */
export const IFrogCryptoFeedSchema = z.object({
  /**
   * Whether this feed is discoverable in GET /feeds
   *
   * A feed can still be queried as GET /feeds/:feedId or polled as POST /feeds even if it is not discoverable
   * as long as the user knows the feed ID.
   * @default false
   */
  private: z.boolean(),
  /**
   * Unix timestamp in seconds of when this feed will become inactive
   *
   * PCD can only be issued from this feed if it is active
   * @default 0 means the feed is inactive
   */
  activeUntil: z.number().nonnegative().int(),
  /**
   * How long to wait between each PCD issuance in seconds
   */
  cooldown: z.number().nonnegative().int(),
  /**
   * Map of configs for Biome(s) where PCDs can be issued from this feed
   */
  biomes: FrogCryptoFeedBiomeConfigsSchema
});

/**
 * FrogCrypto specific feed configuration
 *
 * Note: It is important to ensure that the feed cannot be discovered by guessing the {@link Feed#id}
 */
export type FrogCryptoFeed = Feed<typeof EdDSAFrogPCDPackage> &
  z.infer<typeof IFrogCryptoFeedSchema>;

/**
 * DB schema for feed data
 */
export const FrogCryptoDbFeedDataSchema = z.object({
  uuid: z.string().uuid(),
  feed: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    private: z.boolean(),
    activeUntil: z.number().nonnegative().int(),
    cooldown: z.number().nonnegative().int(),
    biomes: FrogCryptoFeedBiomeConfigsSchema
  })
});

export type FrogCryptoDbFeedData = z.infer<typeof FrogCryptoDbFeedDataSchema>;

/**
 * The prototype specification for frog creation
 *
 * This represents the raw specification of a frog, which is then used to generate the {@link IFrogData} in the {@link EdDSAFrogPCD}. Some attributes are optional and will be randomly selected if not specified.
 * This mirrors the specification from the design spreadsheet and is wrapped as {@link FrogCryptoDbFrogData} to store in the database.
 * See {@link FrogCryptoFeed} for the feed configuration and how Frog prototypes are selected.
 *
 * Undefined numeric attribute means that the value will be randomly selected from [0, 10].
 */
export const FrogCryptoFrogDataSchema = z.object({
  id: z.number().nonnegative().int(),
  uuid: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1),
  biome: z.string().min(1),
  rarity: z.string().min(1),
  /**
   * undefined means the temperament will be randomly selected
   */
  temperament: z.string().optional(),
  drop_weight: z.number().nonnegative(),
  jump_min: z.number().gte(0).lte(10).optional(),
  jump_max: z.number().gte(0).lte(10).optional(),
  speed_min: z.number().gte(0).lte(10).optional(),
  speed_max: z.number().gte(0).lte(10).optional(),
  intelligence_min: z.number().gte(0).lte(10).optional(),
  intelligence_max: z.number().gte(0).lte(10).optional(),
  beauty_min: z.number().gte(0).lte(10).optional(),
  beauty_max: z.number().gte(0).lte(10).optional()
});

export type FrogCryptoFrogData = z.infer<typeof FrogCryptoFrogDataSchema>;

/**
 * DB schema for frog data
 */
export interface FrogCryptoDbFrogData {
  id: number;
  uuid: string;
  frog: Omit<FrogCryptoFrogData, "id" | "uuid">;
}

/**
 * All FrogCrypto PCDs are stored in a folder named "FrogCrypto".
 */
export const FrogCryptoFolderName = "FrogCrypto";

/**
 * User score data and computed rank
 */
export interface FrogCryptoScore {
  semaphore_id: string;
  score: number;
  rank: number;
}
