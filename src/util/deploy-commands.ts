import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v9';
import { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { RendezvousCommand, OutcomeTypeConstraint } from 'discord-rendezvous';

const commands = new Array<RESTPostAPIApplicationCommandsJSONBody>();
const commandsPath = pathToFileURL(path.join(process.cwd(), './src/commands'));

const addCommandsFromPath = async (commandsPath: URL) => {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));
    for (const file of commandFiles) {
        const filePath = pathToFileURL(path.join(fileURLToPath(commandsPath), file)).toString();
        const command = (await import(filePath)).default as RendezvousCommand<OutcomeTypeConstraint, unknown, unknown>;
        commands.push(command.interfacer!.toJSON());
        console.log(`Added command ${command.interfacer!.name} from ${filePath}`);
    }
};

// Slash commands (also known as Chat Input commands)
const slashCommandsPath = pathToFileURL(path.join(fileURLToPath(commandsPath), './slashcommands'));
await addCommandsFromPath(slashCommandsPath);
// Message commands
const messageCommandsPath = pathToFileURL(path.join(fileURLToPath(commandsPath), './messagecommands'));
await addCommandsFromPath(messageCommandsPath);

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN as string);

rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID as string, process.env.TESTING_GUILD_ID as string), { body: commands })
    .then(() => console.log('Successfully registered application commands.'))
    .catch(console.error);