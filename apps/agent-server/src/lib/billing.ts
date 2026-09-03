// Toji plans, and the one place that answers "is this person subscribed".
//
// The plans are described here rather than in the UI so the server, the settings
// panel and the plans page can never disagree about what a tier costs or includes.
//
// Entitlement is deliberately a single, honest function. There is no Toji service to
// ask yet: nothing here validates a subscription against a server, and a token in the
// local settings file is not proof of payment — it is the seam that a real check will
// replace. Until then subscriptionStatus() reports the free tier, so the app never
// claims to have unlocked something it hasn't.

export type PlanId = 'free' | 'pro' | 'max';

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in whole US dollars. 0 = free. */
  priceUsd: number;
  tagline: string;
  features: string[];
  /** The plan a new install lands on until it is told otherwise. */
  highlight?: boolean;
  /**
   * Stripe Payment Link for this plan. Empty until Toji's own Stripe account exists —
   * the plans page shows the tier as not yet purchasable rather than opening a
   * checkout that would bill the wrong business.
   */
  checkoutUrl: string;
}

/** Cerebras model each paid tier runs by default. Free brings its own backend. */
export const MANAGED_MODEL_DEFAULT = 'qwen-3.8-27b';

function checkoutUrlFor(plan: PlanId): string {
  const value = process.env[`TOJI_CHECKOUT_URL_${plan.toUpperCase()}`];
  return typeof value === 'string' ? value.trim() : '';
}

export function plans(): Plan[] {
  return [
    {
      id: 'free',
      name: 'Free',
      priceUsd: 0,
      tagline: 'Bring your own agent. Everything stays on your machine.',
      features: [
        'Every coding CLI you are already signed into',
        'Your own Cerebras key or any OpenAI-compatible endpoint',
        'All the browser: profiles, Tor, the password vault',
        'No account, no telemetry'
      ],
      checkoutUrl: ''
    },
    {
      id: 'pro',
      name: 'Pro',
      priceUsd: 20,
      tagline: 'Inference that works out of the box — nothing to install or paste.',
      highlight: true,
      features: [
        `Managed Cerebras access (${MANAGED_MODEL_DEFAULT} by default)`,
        'No API key, no CLI to install and sign into',
        'Generated answer pages and the web agent, ready on first launch',
        'Everything in Free'
      ],
      checkoutUrl: checkoutUrlFor('pro')
    },
    {
      id: 'max',
      name: 'Max',
      priceUsd: 60,
      tagline: 'For running the agent all day.',
      features: ['Much higher usage limits', 'The largest models the account can reach', 'Priority capacity at busy times', 'Everything in Pro'],
      checkoutUrl: checkoutUrlFor('max')
    }
  ];
}

export interface SubscriptionStatus {
  plan: PlanId;
  /** True only when Toji can actually run inference on the user's behalf. */
  active: boolean;
  /** Why it is inactive, for the UI to explain rather than just refuse. */
  reason?: string;
}

/**
 * The current subscription.
 *
 * Always the free tier today: billing is not connected, so there is nothing to check
 * against. When Toji's hosted service exists this is where its token is verified —
 * one function, one call site, so nothing else in the app has to learn about billing.
 */
export function subscriptionStatus(): SubscriptionStatus {
  return { plan: 'free', active: false, reason: 'Toji subscriptions are not open yet.' };
}
