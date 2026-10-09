import { generateLeague } from "../src/lib/simulator/league";

const { teams, players } = generateLeague();
console.log(teams.length, "teams,", players.length, "players");
console.log(teams.slice(0, 3));
console.log(players.slice(0, 3));