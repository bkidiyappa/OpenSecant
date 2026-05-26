/**
 * Retry strategy for self-healing step resolution.
 */

const DEFAULT_MAX_HEAL_ROUNDS = 2;

function getMaxHealRounds() {
  const fromEnv = parseInt(process.env.OPENSECANT_HEAL_ROUNDS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_HEAL_ROUNDS;
}

module.exports = {
  DEFAULT_MAX_HEAL_ROUNDS,
  getMaxHealRounds,
};
