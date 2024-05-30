import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { RendezvousClient as TournamentionClient } from 'discord-rendezvous';

const addCommandsFromPath = async (client: TournamentionClient, commandsPath: URL) => {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));
    for (const file of commandFiles) {
        const filePath = pathToFileURL(path.join(fileURLToPath(commandsPath), file)).toString();
        const command = (await import(filePath)).default;
        client.addCommands([{ name: command.interfacer.name, command: command }]);
    }
};

export const prepareCommands = async (client: TournamentionClient) => {
    const commandsPath = pathToFileURL(path.join(process.cwd(), './src/commands'));
    // Slash commands (also known as Chat Input commands)
    const slashCommandsPath = pathToFileURL(path.join(fileURLToPath(commandsPath), './slashcommands'));
    await addCommandsFromPath(client, slashCommandsPath);
    // Message commands
    const messageCommandsPath = pathToFileURL(path.join(fileURLToPath(commandsPath), './messagecommands'));
    await addCommandsFromPath(client, messageCommandsPath);
};