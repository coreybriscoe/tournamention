import { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { getCurrentTournament } from '../../../backend/queries/guildSettingsQueries.js';
import { getPendingSubmissionsOfTournamentPaged } from '../../../backend/queries/submissionQueries.js';
import { getTournamentByName } from '../../../backend/queries/tournamentQueries.js';
import { ResolvedSubmission, ResolvedTournament } from '../../../types/customDocument.js';
import config from '../../../config.js';
import { RendezvousClient as TournamentionClient, OutcomeStatus, PaginatedOutcome, Outcome, SlashCommandDescribedOutcome, SlashCommandEmbedDescribedOutcome, OptionValidationErrorOutcome, OptionValidationErrorStatus, firstButton, lastButton, nextButton, previousButton } from 'discord-rendezvous';
import { PaginatedSolverParams } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
export type T1 = string;

/**
 * Alias for the second generic type of the command.
 */
export type T2 = void;

/**
 * Status codes specific to this command.
 */
export enum PendingSubmissionsSpecificStatus {
    SUCCESS_DETAILS = 'SUCCESS_DETAILS',
    FAIL_NONE_PENDING = 'FAIL_NONE_PENDING',
}

/**
 * Union of specific and generic status codes.
 */
export type PendingSubmissionsStatus = PendingSubmissionsSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
export type PendingSubmissionsSuccessDetailsOutcome = PaginatedOutcome & {
    status: PendingSubmissionsSpecificStatus.SUCCESS_DETAILS;
    body: {
        submissions: ResolvedSubmission[];
        tournament: ResolvedTournament;
        serverDetails: {
            name: string;
            icon: string;
        }
    };
};

export type PendingSubmissionsFailNonePendingOutcome = {
    status: PendingSubmissionsSpecificStatus.FAIL_NONE_PENDING
    body: {
        context: string;
    },
};

/**
 * Union of specific and generic outcomes.
 */
export type PendingSubmissionsSpecificOutcome = PendingSubmissionsSuccessDetailsOutcome | PendingSubmissionsFailNonePendingOutcome;

export type PendingSubmissionsOutcome = Outcome<T1, T2, PendingSubmissionsSpecificOutcome>;

/**
 * The object defining parameter for the solver function, as well as the "S" generic type,
 * are defined externally to prevent circular dependencies.
 */
interface PendingSubmissionsIntrinsicSolverParams {
    guildId: string;
    tournament?: string | undefined;
}

export type PendingSubmissionsSolverParams = PendingSubmissionsIntrinsicSolverParams & PaginatedSolverParams;

export const pendingSubmissionsSolver = async (params: PendingSubmissionsSolverParams): Promise<PendingSubmissionsOutcome> => {
    try {
        const client = TournamentionClient.getInstance();
        const guild = (await client).guilds.fetch(params.guildId);
        const tournamentDocument = params.tournament ? await getTournamentByName(params.guildId, params.tournament) : await getCurrentTournament(params.guildId);
        const { submissions, totalCount, totalPages } = await getPendingSubmissionsOfTournamentPaged(tournamentDocument!, params.page);

        // If there are none, return a specific outcome
        if (submissions.length === 0) return {
            status: PendingSubmissionsSpecificStatus.FAIL_NONE_PENDING,
            body: {
                context: 'submissions',
            },
        } as PendingSubmissionsFailNonePendingOutcome;

        const serverDetails = {
            name: (await guild).name,
            icon: (await guild).iconURL() ?? 'https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/02/Pointer_%28texture%29_JE1_BE1.png',
        };

        // Resolve all submissions
        const resolvedSubmissions = new Array<ResolvedSubmission>();
        for (const submission of submissions) resolvedSubmissions.push(await new ResolvedSubmission(submission).make());

        return {
            status: PendingSubmissionsSpecificStatus.SUCCESS_DETAILS,
            body: {
                submissions: resolvedSubmissions,
                tournament: await new ResolvedTournament(tournamentDocument!).make(),
                serverDetails,
                totalPages,
            },
            pagination: {
                page: params.page,
                totalPages,
                totalCount,
            }
        } as PendingSubmissionsSuccessDetailsOutcome;
    } catch (err) {
        // No expected thrown errors
    }

    return {
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    };
};

const formatSubmissionsDetails = (submissions: ResolvedSubmission[], page: number): string => {
    let result = '';
    let count = page * config.pagination.pendingSubmissionsPerPage + 1;
    for (const sub of submissions) {
        result += `${count++}. ${sub.challenge.difficulty ? sub.challenge.difficulty.emoji : ''} **${sub.challenge.name}** by <@${sub.contestant.userID}>: ${sub.proof}\n`;
    }

    return result;
};

export const pendingSubmissionsSlashCommandDescriptions = new Map<PendingSubmissionsStatus, (o: PendingSubmissionsOutcome) => SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome>([
    [PendingSubmissionsSpecificStatus.SUCCESS_DETAILS, (o: PendingSubmissionsOutcome) => {
        const oBody = (o as PendingSubmissionsSuccessDetailsOutcome).body;
        const components = [new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                firstButton.getBuilder(),
                previousButton.getBuilder(),
                nextButton.getBuilder(),
                lastButton.getBuilder(),
            )
            .toJSON()
        ];
        // Disable the last and previous buttons intially when on the first page
        const currentPage = (o as PaginatedOutcome).pagination.page;
        components[0].components[0].disabled = currentPage === 0;
        components[0].components[1].disabled = currentPage === 0;
        // Disable the first and next buttons intially when on the last page
        const totalPages = (o as PaginatedOutcome).pagination.totalPages;
        components[0].components[2].disabled = currentPage === totalPages - 1;
        components[0].components[3].disabled = currentPage === totalPages - 1;
        return {
            embeds: [new EmbedBuilder()
                .setTitle(`${(o as PaginatedOutcome).pagination.totalCount!} Pending Submissions in ${oBody.tournament.name}`)
                .setDescription(formatSubmissionsDetails(oBody.submissions, currentPage))
                .setThumbnail(oBody.serverDetails.icon)
                .toJSON()
            ],
            components, 
            ephemeral: true,
        } as SlashCommandEmbedDescribedOutcome;
    }],
    [OutcomeStatus.FAIL_VALIDATION, (o: PendingSubmissionsOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) {
            if (oBody.field === 'tournament') return {
                userMessage: `❌ The tournament **${oBody.value}** was not found.`, ephemeral: true,
            };
            else return {
                userMessage: `❌ The ${oBody.field} **${oBody.value}** was not found in the tournament.`, ephemeral: true,
            };
        } else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_UNDEFAULTABLE) return {
            userMessage: `❌ There is no current tournament. You can instead try to specify a tournament by name.`, ephemeral: true,
        };
        else return {
            userMessage: `❌ This command failed due to a validation error.`, ephemeral: true,
        };
    }],
    [PendingSubmissionsSpecificStatus.FAIL_NONE_PENDING, (_: PendingSubmissionsOutcome) => ({
        userMessage: `✅ There are no pending submissions in the tournament.`, ephemeral: true,
    })],
]);