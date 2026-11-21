/** How spammy a message reads: pure text scoring, no database (so it can be tested on its own). */

// Each pattern that matches adds its weight; 4 or more is spam.
const SIGNALS: [RegExp, number][] = [
  [/\b(you('ve| have)? won|winner|lottery|lucky draw|jackpot|claim (your )?(prize|reward|gift))\b/i, 3],
  [/\b(kyc|pan|aadhaa?r)\b.{0,40}\b(update|expire|block|suspend|verify)/i, 3],
  [/\b(account|card|sim|wallet)\b.{0,30}\b(blocked|suspended|deactivated|will be (closed|blocked))/i, 3],
  [/\b(share|send)\b.{0,20}\b(otp|pin|cvv)\b/i, 3],
  [/\b(earn|income|salary)\b.{0,30}(₹|rs\.?|inr|\$)\s?[\d,]+.{0,30}\b(per|a|\/)\s?(day|week|hour)/i, 3],
  [/\b(work from home|part[- ]time job|daily payout|task based job|like (and|&) earn)\b/i, 2],
  [/\b(crypto|bitcoin|forex|trading)\b.{0,40}\b(profit|returns?|signals?|guaranteed|double)/i, 3],
  [/\b(guaranteed|100%)\b.{0,20}\b(returns?|profit|approval|loan)/i, 2],
  [/\b(pre-?approved|instant)\b.{0,20}\b(loan|credit)/i, 2],
  [/\b(act now|limited time|urgent(ly)?|immediately|last chance|expires? today)\b/i, 1],
  [/\b(click (here|the link|below)|tap (here|the link))\b/i, 1],
  [/\b(free (gift|recharge|iphone|money)|cash ?back of)\b/i, 2],
  [/\b(dear (customer|user|winner|friend|beneficiary))\b/i, 1],
  [/(bit\.ly|tinyurl|t\.me\/\+|wa\.me|goo\.gl|cutt\.ly|rb\.gy)\//i, 1],
  [/\b(telegram|whatsapp)\b.{0,20}\b(group|channel)\b.{0,20}\b(join|link)/i, 1],
];

// Safety warnings real banks and apps send ("we will never ask you to share your OTP",
// "do not click unknown links") use the same words as scams; they don't count.
const WARNING = /\b(never|do not|don't|not|won't|cannot|can't)\b[^.!?\n]{0,60}/gi;

/** How spammy a message reads (0 = clean). Exported for tests. */
export function spamScore(text: string, subject?: string | null) {
  const all = `${subject ?? ""}\n${text}`.replace(WARNING, " ");
  let score = 0;
  for (const [re, weight] of SIGNALS) if (re.test(all)) score += weight;
  const links = all.match(/https?:\/\//g)?.length ?? 0;
  if (links >= 3) score += 1;
  // Shouting: mostly capitals in a message of real length.
  const letters = all.replace(/[^a-z]/gi, "");
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) score += 1;
  return score;
}

export const SPAM_THRESHOLD = 4;
