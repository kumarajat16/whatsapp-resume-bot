const crypto = require('crypto');

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateReferralId() {
  const bytes = crypto.randomBytes(7);
  let id = 'rw';
  for (let i = 0; i < 7; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
  return id;
}

const MILESTONE_STEP = 5;
const MAX_MILESTONES = 10;
const PER_MILESTONE = 50;
const BUMPER_AT = 51;
const BUMPER_AMOUNT = 500;
const MAX_TOTAL = MAX_MILESTONES * PER_MILESTONE + BUMPER_AMOUNT;

function computeRewards(count) {
  const milestonesHit = Math.min(Math.floor(count / MILESTONE_STEP), MAX_MILESTONES);
  const milestoneAmount = milestonesHit * PER_MILESTONE;
  const bumper = count >= BUMPER_AT ? BUMPER_AMOUNT : 0;
  const earned = milestoneAmount + bumper;

  let next = null;
  if (count < MAX_MILESTONES * MILESTONE_STEP) {
    const nextCount = (milestonesHit + 1) * MILESTONE_STEP;
    next = {
      count: nextCount,
      reward: PER_MILESTONE,
      refs_away: nextCount - count,
      kind: 'milestone',
    };
  } else if (count < BUMPER_AT) {
    next = {
      count: BUMPER_AT,
      reward: BUMPER_AMOUNT,
      refs_away: BUMPER_AT - count,
      kind: 'bumper',
    };
  }

  return {
    count,
    earned,
    milestones_hit: milestonesHit,
    next,
    max_possible: MAX_TOTAL,
    bumper_at: BUMPER_AT,
    bumper_amount: BUMPER_AMOUNT,
    bumper_unlocked: count >= BUMPER_AT,
  };
}

module.exports = {
  generateReferralId,
  computeRewards,
  MILESTONE_STEP,
  MAX_MILESTONES,
  PER_MILESTONE,
  BUMPER_AT,
  BUMPER_AMOUNT,
  MAX_TOTAL,
};
