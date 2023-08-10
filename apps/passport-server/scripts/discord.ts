/**
 * Script used for registering slash commands to a server.
 * To register slash commands to a particular guild, use `npm run discord -- --guildId <guildId>`
 * To reset slash commands for a particular guild, use `npm run discord -- --guildId <guildId> --reset`
 * To get guildId, open Discord, go to User Settings -> Advanced and enable developer mode.
 * Then, right-click on the server title and select "Copy ID" to get the guild ID.
 * To deploy slash commands globally, use `npm run discord`
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import * as dotenv from "dotenv";
import * as path from "path";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from "../src/util/logger";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const token: string = process.env.DISCORD_TOKEN;
const clientId: string = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  logger("missing discord token or client ID");
  process.exit(0);
}

const args = yargs(hideBin(process.argv))
  .options({
    guildId: { type: 'string', default: null },
    reset: { type: 'boolean', default: false },
  })
  .parseSync()

if (args.reset && !args.guildId) {
  logger("resetting slash commands only works when guildId specified. exiting.");
  process.exit(0);
}

const commandsRaw = [
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription(
      'Responds with a verification link!'
    ),
]
const commands = args.reset? [] : commandsRaw.map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

const routes = args.guildId?
  Routes.applicationGuildCommands(clientId, args.guildId) :
    Routes.applicationCommands(clientId);

rest.put(routes, { body: commands })
  .then(() => {
    const log = args.reset? "successfully resetted slash commands" :
        "successfully registered slash commands";
    logger(log);
  })
  .catch((e) => logger(e))
  .finally(() => process.exit(0))
