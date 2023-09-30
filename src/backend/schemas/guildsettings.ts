import { prop, getModelForClass } from '@typegoose/typegoose';
import { TournamentModel, Tournament } from './tournament.js';
import { TournamentDocument } from '../../types/customDocument.js';
import { ObjectId } from 'mongodb';

export class GuildSettings {
    _id!: ObjectId;

    @prop({ required: true, unique: true })
    public guildID!: string;

    public async getCurrentTournament(): Promise<TournamentDocument | null> {
        // TODO: test performance WRT frequent .toObject() calls, would a separate array of Tournament be faster?
        const guildTournaments = (await TournamentModel.find({ guildID: this.guildID }));
        const activeTournament = guildTournaments
            .filter((t: TournamentDocument) => {
                return t.toObject().active;
            })
            .reduce((prev: TournamentDocument, curr: TournamentDocument) => {
                const prevTournament: Tournament = prev.toObject();
                const currTournament: Tournament = curr.toObject();
                return !prevTournament.name 
                    && prevTournament._id.getTimestamp().getTime() > currTournament._id.getTimestamp().getTime() 
                    ? prev : curr;
            });
        return activeTournament ? activeTournament : null;
    }
}

export const GuildSettingsModel = getModelForClass(GuildSettings);