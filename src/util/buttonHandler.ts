import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { RendezvousClient as TournamentionClient } from 'discord-rendezvous';

const addButtonsFromPath = async (client: TournamentionClient, buttonsPath: URL) => {
    const commandFiles = fs.readdirSync(buttonsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));
    for (const file of commandFiles) {
        const filePath = pathToFileURL(path.join(fileURLToPath(buttonsPath), file)).toString();
        const button = (await import(filePath)).default;
        client.addButtons([{ customId: button.getCustomId(), button }]);
    }
};

export const prepareButtons = async (client: TournamentionClient) => {
    const buttonsPath = pathToFileURL(path.join(process.cwd(), './src/buttons'));
    // Buttons
    await addButtonsFromPath(client, buttonsPath);
};