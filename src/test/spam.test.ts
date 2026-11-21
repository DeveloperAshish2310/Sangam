import { describe, expect, it } from "vitest";
import { SPAM_THRESHOLD, spamScore } from "../../backend/spam-score";

const isSpam = (text: string, subject?: string) => spamScore(text, subject) >= SPAM_THRESHOLD;

describe("spam score", () => {
  it.each([
    ["Congratulations! You have won ₹25,00,000 in the KBC lucky draw. Claim your prize now: bit.ly/kbc-win"],
    ["Dear customer, your SBI account will be blocked today. Update your KYC immediately: http://sbi-kyc.co"],
    ["Earn ₹5000 per day from home! Part-time job, daily payout. Join our telegram group link"],
    ["Guaranteed 300% returns with our crypto trading signals. Double your bitcoin profit, act now!"],
    ["Hi, please share the OTP you just received so I can verify your account, it's urgent"],
  ])("flags: %s", (text) => {
    expect(isSpam(text)).toBe(true);
  });

  it.each([
    ["Hey, are we still on for dinner tonight?"],
    ["Your OTP is 482913. Never share your OTP or PIN with anyone. HDFC Bank will never ask for it.", "Your OTP"],
    ["Please find attached the invoice for October. Let me know if anything needs to change.", "Invoice #1042"],
    ["Reminder: your Netflix plan renews on 12 Nov. Manage it in your account settings.", "Your membership"],
    ["The build is failing on main, can you take a look when you get a chance? https://github.com/x/y/actions/1"],
    ["Interview scheduled for Monday 10 AM. Join the Google Meet link 5 minutes early.", "Interview with Wissen Technology"],
    ["Do not click links in messages claiming your account is blocked; we never send those.", "Security tip"],
  ])("leaves alone: %s", (text: string, subject?: string) => {
    expect(isSpam(text, subject)).toBe(false);
  });
});
