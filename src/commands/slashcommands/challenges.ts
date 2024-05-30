import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, GuildMember, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { ValueOf } from '../../types/typelogic.js';
import { getDifficultyByEmoji, getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getChallengesOfTournamentByDifficulty, getChallengesOfTournamentByGame, getChallengesOfTournamentByGamePaged, getChallengesOfTournamentPaged } from '../../backend/queries/challengeQueries.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import { ChallengeDocument, ResolvedChallenge, ResolvedTournament } from '../../types/customDocument.js';
import { RendezvousClient as TournamentionClient, OutcomeStatus, PaginatedOutcome, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, LimitedCommandInteractionOption, ALWAYS_OPTION_CONSTRAINT, OptionValidationErrorStatus, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, SlashCommandEmbedDescribedOutcome, SimpleRendezvousSlashCommand, firstButton, lastButton, nextButton, previousButton } from 'discord-rendezvous';
import { PaginatedSolverParams } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = Map<string, ResolvedChallenge[]> | string;

/**
 * Alias for the second generic type of the command.
 */
type T2 = string;

/**
 * Status codes specific to this command.
 */
enum ChallengesSpecificStatus {
    SUCCESS_DETAILS = 'SUCCESS_DETAILS',
    FAIL_NO_VISIBLE_CHALLENGES = 'FAIL_NO_VISIBLE_CHALLENGES',
}

/**
 * Union of specific and generic status codes.
 */
export type ChallengesStatus = ChallengesSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type ChallengesSuccessDetailsOutcome = PaginatedOutcome & {
    status: ChallengesSpecificStatus.SUCCESS_DETAILS;
    body: {
        gamesAndChallenges: Map<string, ResolvedChallenge[]>;
        tournament: ResolvedTournament;
        serverDetails: {
            name: string;
            icon: string;
        }
    };
};
type ChallengesFailNoVisibleChallengesOutcome = {
    status: ChallengesSpecificStatus.FAIL_NO_VISIBLE_CHALLENGES;
    body: {
        context: string;
    },
};

/**
 * Union of specific and generic outcomes.
 */
type ChallengesSpecificOutcome = ChallengesSuccessDetailsOutcome | ChallengesFailNoVisibleChallengesOutcome;

type ChallengesOutcome = Outcome<T1, T2, ChallengesSpecificOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface ChallengesIntrinsicSolverParams {
    guildId: string;
    judgeView: boolean;
    tournament?: string | undefined;
    game?: string | undefined;
    difficulty?: string | undefined;
}

export type ChallengesSolverParams = ChallengesIntrinsicSolverParams & PaginatedSolverParams;

export const challengesSolver = async (params: ChallengesSolverParams): Promise<ChallengesOutcome> => {
    try {
        const client = TournamentionClient.getInstance();
        const guild = (await client).guilds.fetch(params.guildId);
        const tournamentDocument = params.tournament ? await getTournamentByName(params.guildId, params.tournament) : await getCurrentTournament(params.guildId);
        const { challenges, totalPages } = params.game ? await getChallengesOfTournamentByGamePaged(tournamentDocument!, params.game!, params.page) : await getChallengesOfTournamentPaged(tournamentDocument!, params.page);
        const difficultyDocument = params.difficulty ? await getDifficultyByEmoji(tournamentDocument!, params.difficulty) : null;

        // Cases where no challenges were found for the one or two filters should be caught by the validation step
        // However, there may be no challenges at all in the tournament:
        if (challenges.length === 0) {
            return {
                status: OutcomeStatus.FAIL,
                body: {},
            };
        }
        // If there are no visible challenges in non-judge view, display a distinct message:
        if (!params.judgeView && !challenges.some((challenge: ChallengeDocument) => challenge.visibility)) {
            return {
                status: ChallengesSpecificStatus.FAIL_NO_VISIBLE_CHALLENGES,
                body: {
                    context: 'visible challenges',
                },
            };
        }
    
        // Build map from game to its challenges with some possible filters
        const gamesAndChallenges = new Map<string, ResolvedChallenge[]>();
        for (const challenge of challenges) {
            // Filter challenges by visibility if judgeView is False
            if (!challenge.visibility && !params.judgeView) {
                continue;
            }
            // Filter challenges by difficulty if difficultyId is provided
            if (params.difficulty && !challenge.difficulty?._id.equals(difficultyDocument!._id)) {
                continue;
            }
            // Add to map
            if (!gamesAndChallenges.has(challenge.game)) gamesAndChallenges.set(challenge.game, []);
            gamesAndChallenges.get(challenge.game)!.push(await new ResolvedChallenge(challenge).make());
        }

        const serverDetails = {
            name: (await guild).name,
            icon: (await guild).iconURL() ?? 'https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/02/Pointer_%28texture%29_JE1_BE1.png',
        };

        return {
            status: ChallengesSpecificStatus.SUCCESS_DETAILS,
            body: {
                gamesAndChallenges,
                tournament: await new ResolvedTournament(tournamentDocument!).make(),
                serverDetails,
                totalPages,
            },
            pagination: {
                page: params.page,
                totalPages,
            }
        } as ChallengesSuccessDetailsOutcome;
    } catch (err) {
        // No expected thrown errors
    }

    return {
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    };
};

const challengesSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<ChallengesSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    // contestantView is True iff user supplies True.
    // judgeView <=> !contestantView && memberIsJudgeOrAdmin
    const contestantView = interaction.options.get('contestantview', false)?.value as boolean ?? false;
    const tournament = interaction.options.get('tournament', false);
    const game = interaction.options.get('game', false);
    const difficulty = interaction.options.get('difficulty', false);

    const judge = await getJudgeByGuildIdAndMemberId(guildId, (interaction.member as GuildMember).id);
    const memberIsJudgeOrAdmin = (judge && judge.isActiveJudge) || (interaction.member as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
    
    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([]);
    const optionConstraints = new Map<LimitedCommandInteractionOption | null | ALWAYS_OPTION_CONSTRAINT, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([
        [tournament, [
            // Ensure that the tournament exists, if it was provided
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = await getTournamentByName(guildId, option as string);
                    return tournamentDocument !== null;
                }
            },
        ]],
        ['ALWAYS_OPTION_CONSTRAINT', [
            // Ensure that either the specified Tournament exists (seemingly redundantly) or there is a current Tournament
            {
                category: OptionValidationErrorStatus.OPTION_UNDEFAULTABLE,
                func: async function(_: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return tournamentDocument !== null;
                },
            },
        ]],
        [game, [
            // Ensure that some challenge exists for the specified game
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return (await getChallengesOfTournamentByGame(tournamentDocument!, option as string)).length > 0;
                },
            },
        ]],
        [difficulty, [
            // Ensure that some challenge exists for the specified difficulty
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    const difficultyDocument = await getDifficultyByEmoji(tournamentDocument!, option as string);
                    if (!difficultyDocument) return false;
                    return (await getChallengesOfTournamentByDifficulty(tournamentDocument!, difficultyDocument)).length > 0;
                },
            },
            // Joint constraint of game and difficulty: ensure that some challenge exists for the specified game and difficulty, if game is also provided
            // TODO: this could be made a joint constraint, pending #54. This is equivalent logically but conveys a less detailed error message this way.
            {
                category: OptionValidationErrorStatus.OPTION_INVALID,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    const difficultyDocument = await getDifficultyByEmoji(tournamentDocument!, option as string);
                    if (!game) return true;
                    const gameChallenges = await getChallengesOfTournamentByGame(tournamentDocument!, game.value as string);
                    const difficultyChallenges = await getChallengesOfTournamentByDifficulty(tournamentDocument!, difficultyDocument!);
                    return gameChallenges.some((gameChallenge: ChallengeDocument) => difficultyChallenges.some((difficultyChallenge: ChallengeDocument) => gameChallenge._id.equals(difficultyChallenge._id)));
                },
            },
        ]],
    ]);

    try {
        await validateConstraints(interaction, metadataConstraints, optionConstraints);
    } catch (err) {
        if (err instanceof OptionValidationError) return {
            status: OutcomeStatus.FAIL_VALIDATION,
            body: {
                constraint: err.constraint,
                field: err.field,
                value: err.value,
                context: err.message,
            },
        };

        throw err;
    }

    return {
        guildId,
        judgeView: !contestantView && memberIsJudgeOrAdmin,
        tournament: tournament?.value as string | undefined,
        game: game?.value as string | undefined,
        difficulty: difficulty?.value as string | undefined,
        page: 0,
    };
};

/**
 * Converts a map of games and `ResolvedChallenges`, along with optional `ResolvedTournament`, to a string.
 * @param gamesAndChallenges A Map of game name to `ResolvedChallenge` array of its challenges to be displayed in the provided order.
 */
export const formatChallengesDetails = (gamesAndChallenges: Map<string, ResolvedChallenge[]>): string => {
    let result = '';

    for (const [game, challenges] of gamesAndChallenges) {
        result += `\n*${game}*\n`;
        for (const challenge of challenges) {
            result += `${challenge.difficulty ? challenge.difficulty.emoji + ' ' : ''}**${challenge.name}** ${challenge.description}${challenge.visibility ? '' : ' (💭 hidden)'}\n`;
        }
    }

    return result;
};

export const challengesSlashCommandDescriptions = new Map<ChallengesStatus, (o: ChallengesOutcome) => SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome>([
    [ChallengesSpecificStatus.SUCCESS_DETAILS, (o: ChallengesOutcome) => {
        const oBody = (o as ChallengesSuccessDetailsOutcome).body;
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
                .setTitle(`Challenges in ${oBody.tournament.name}`)
                .setDescription(formatChallengesDetails(oBody.gamesAndChallenges))
                .setThumbnail(oBody.serverDetails.icon)
                .toJSON()
            ],
            components, 
            ephemeral: true,
        } as SlashCommandEmbedDescribedOutcome;
    }],
    [OutcomeStatus.FAIL_VALIDATION, (o: ChallengesOutcome) => {
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
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_INVALID) return {
            userMessage: `❌ There are no challenges for that game with the difficulty ${oBody.value} in the tournament.`, ephemeral: true,
        };
        else return {
            userMessage: `❌ This command failed due to a validation error.`, ephemeral: true,
        };
    }],
    [OutcomeStatus.FAIL, (_: ChallengesOutcome) => ({
        userMessage: `❌ There are no challenges in the tournament.`, ephemeral: true,
    })],
    [ChallengesSpecificStatus.FAIL_NO_VISIBLE_CHALLENGES, (_: ChallengesOutcome) => ({
        userMessage: `❌ There are no visible challenges in the tournament.`, ephemeral: true,
    })],
]);

const ChallengesCommand = new SimpleRendezvousSlashCommand<ChallengesOutcome, ChallengesSolverParams, T1, ChallengesStatus>(
    new SlashCommandBuilder()
        .setName('challenges')
        .setDescription('Show the challenges posted for a tournament.')
        .addStringOption(option => option.setName('tournament').setDescription('The tournament to view. Defaults to current tournament.').setRequired(false))
        .addStringOption(option => option.setName('game').setDescription('The name of the game to filter challenges by.').setRequired(false))
        .addStringOption(option => option.setName('difficulty').setDescription('The difficulty emoji to filter challenges by.').setRequired(false))
        .addBooleanOption(option => option.setName('contestantview').setDescription('Judges can use True to only show visible challenges, to see what a contestant sees.').setRequired(false)) as SlashCommandBuilder,
    challengesSlashCommandDescriptions,
    challengesSlashCommandValidator,
    challengesSolver,
    false,
    true,
);

export default ChallengesCommand;