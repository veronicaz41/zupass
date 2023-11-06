import { getHash } from "@pcd/passport-crypto";
import { Pool, PoolClient } from "postgres-pool";
import { DevconnectPretixRedactedTicket } from "../../models";
import { sqlQuery, sqlTransaction } from "../../sqlQuery";

export async function upsertDevconnectPretixRedactedTicket(
  client: Pool,
  params: DevconnectPretixRedactedTicket
): Promise<void> {
  await sqlQuery(
    client,
    `\
    INSERT INTO devconnect_pretix_redacted_tickets
    (hashed_email, is_consumed, position_id, secret, checker, pretix_checkin_timestamp, devconnect_pretix_items_info_id,
      pretix_events_config_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(pretix_events_config_id, position_id) DO
    UPDATE SET hashed_email = $1, is_consumed = $2, secret = $4, checker = $5, pretix_checkin_timestamp = $6,
    devconnect_pretix_items_info_id = $7, pretix_events_config_id = $8
    `,
    [
      params.hashed_email,
      params.is_consumed,
      params.position_id,
      params.secret,
      params.checker,
      params.pretix_checkin_timestamp,
      params.devconnect_pretix_items_info_id,
      params.pretix_events_config_id
    ]
  );
}

export async function deleteDevconnectPretixRedactedTickets(
  client: Pool,
  eventConfigID: string,
  ids: string[]
): Promise<void> {
  await sqlQuery(
    client,
    `DELETE FROM devconnect_pretix_redacted_tickets WHERE pretix_events_config_id = $1
    AND position_id = ANY($2)`,
    [eventConfigID, ids]
  );
}

export async function fetchDevconnectPretixRedactedTicketsByHashedEmail(
  client: Pool,
  hashedEmail: string
): Promise<DevconnectPretixRedactedTicket[]> {
  const result = await sqlQuery(
    client,
    `\
    SELECT * FROM devconnect_pretix_redacted_tickets
    WHERE hashed_email = $1
    `,
    [hashedEmail]
  );

  return result.rows;
}

export async function fetchDevconnectPretixRedactedTicketsByEvent(
  client: Pool,
  eventConfigID: string
): Promise<DevconnectPretixRedactedTicket[]> {
  const result = await sqlQuery(
    client,
    `\
    SELECT t.* FROM devconnect_pretix_redacted_tickets t
    WHERE t.pretix_events_config_id = $1`,
    [eventConfigID]
  );

  return result.rows;
}

export async function agreeTermsAndUnredactTickets(
  client: Pool,
  email: string,
  version: number
): Promise<void> {
  const hashedEmail = await getHash(email);
  await sqlTransaction<void>(
    client,
    "agree terms and unredact tickets",
    async (txClient: PoolClient) => {
      await txClient.query(
        "UPDATE users SET terms_agreed = $1 WHERE email = $2",
        [version, email]
      );

      const redacted = (
        await txClient.query(
          "SELECT * FROM devconnect_pretix_redacted_tickets WHERE hashed_email = $1",
          [hashedEmail]
        )
      ).rows as DevconnectPretixRedactedTicket[];

      for (const redactedTicket of redacted) {
        const {
          devconnect_pretix_items_info_id,
          pretix_events_config_id,
          is_consumed,
          position_id,
          secret,
          checker,
          pretix_checkin_timestamp
        } = redactedTicket;

        await txClient.query(
          `
          INSERT INTO devconnect_pretix_tickets
          (email, full_name, devconnect_pretix_items_info_id,
            pretix_events_config_id, is_deleted, is_consumed, position_id,
            secret, checker, zupass_checkin_timestamp,
            pretix_checkin_timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (position_id, pretix_events_config_id) DO
          UPDATE SET email = $1, full_name = $2,
          devconnect_pretix_items_info_id = $3, pretix_events_config_id = $4,
          is_deleted = $5, is_consumed = $6, secret = $8, checker = $9,
          zupass_checkin_timestamp = $10, pretix_checkin_timestamp = $11`,
          [
            email,
            // We don't have the user's name here, but it will get synced
            // from Pretix later
            "",
            devconnect_pretix_items_info_id,
            pretix_events_config_id,
            // If the ticket were deleted, no redacted ticket would exist
            false,
            is_consumed,
            position_id,
            secret,
            checker,
            // Can't have been checked in on Zupass yet
            null,
            pretix_checkin_timestamp
          ]
        );
      }

      await txClient.query(
        `DELETE FROM devconnect_pretix_redacted_tickets WHERE hashed_email = $1`,
        [hashedEmail]
      );
    }
  );
}
