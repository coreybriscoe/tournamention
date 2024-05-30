import { BaseInteraction, ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { CustomEvent } from '../types/customEvent.js';
import { RendezvousClient as TournamentionClient } from 'discord-rendezvous';

const interactionCreate = new CustomEvent(
    'interactionCreate',
    async (interaction: BaseInteraction) => {
        if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

        const tournamentionClient = await TournamentionClient.getInstance();

        if (interaction.isCommand()) {
            const command = tournamentionClient.getCommand((<ChatInputCommandInteraction> interaction).commandName);
            if (!command) {
                return;
            }
            try {
                command.execute(interaction);
            } catch (error) {
                console.error(error);
                interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            }
        } else if (interaction.isButton()) {
            const button = tournamentionClient.getButton((interaction as ButtonInteraction).customId);
            try {
                if (!button) return;
                button.execute(interaction);
            } catch (error) {
                console.error(error);
                interaction.reply({ content: 'There was an error while pressing this button!', ephemeral: true });
            }
        }
    }
);

export default interactionCreate;