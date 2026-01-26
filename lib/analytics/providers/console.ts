/**
 * Console Analytics Provider
 *
 * Development/debug provider that logs all analytics calls to the console.
 * Useful for debugging analytics implementation without sending data to a real provider.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import type {
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '../types';
import type { AnalyticsProvider, ConsoleProviderConfig } from './types';

/**
 * Console Analytics Provider
 *
 * Logs all analytics calls to the browser console in a structured format.
 * Used as the default provider in development mode.
 *
 * @example
 * ```typescript
 * const provider = createConsoleProvider({ prefix: '[Analytics]' });
 * await provider.init();
 * await provider.track('button_clicked', { buttonId: 'signup' });
 * // Console: [Analytics] track: button_clicked { buttonId: 'signup' }
 * ```
 */
export class ConsoleProvider implements AnalyticsProvider {
  readonly name = 'Console';
  readonly type = 'console' as const;

  private ready = false;
  private prefix: string;
  private debug: boolean;
  private userId: string | null = null;
  private userTraits: UserTraits = {};

  constructor(config: ConsoleProviderConfig = {}) {
    this.prefix = config.prefix ?? '[Analytics]';
    this.debug = config.debug ?? true; // Always debug for console provider
  }

  init(): Promise<void> {
    if (this.ready) return Promise.resolve();

    this.log('init', 'Console analytics provider initialized');
    this.ready = true;
    return Promise.resolve();
  }

  identify(userId: string, traits?: UserTraits): Promise<TrackResult> {
    this.userId = userId;
    if (traits) {
      this.userTraits = { ...this.userTraits, ...traits };
    }

    this.log('identify', userId, traits);

    return Promise.resolve({ success: true });
  }

  track(event: string, properties?: EventProperties): Promise<TrackResult> {
    this.log('track', event, {
      ...properties,
      _userId: this.userId,
    });

    return Promise.resolve({ success: true });
  }

  page(name?: string, properties?: PageProperties): Promise<TrackResult> {
    const pageName = name ?? (typeof document !== 'undefined' ? document.title : 'Unknown');
    const pageProperties: PageProperties = {
      title: typeof document !== 'undefined' ? document.title : undefined,
      path: typeof window !== 'undefined' ? window.location.pathname : undefined,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      ...properties,
    };

    this.log('page', pageName, {
      ...pageProperties,
      _userId: this.userId,
    });

    return Promise.resolve({ success: true });
  }

  reset(): Promise<TrackResult> {
    const previousUserId = this.userId;
    this.userId = null;
    this.userTraits = {};

    this.log('reset', `User ${previousUserId} logged out`);

    return Promise.resolve({ success: true });
  }

  isReady(): boolean {
    return this.ready;
  }

  getFeatures(): ProviderFeatures {
    return {
      supportsIdentify: true,
      supportsServerSide: true,
      supportsFeatureFlags: false,
      supportsSessionReplay: false,
      supportsCookieless: true,
    };
  }

  /**
   * Log a message to the console
   */
  private log(method: string, ...args: unknown[]): void {
    if (!this.debug) return;

    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const styles = this.getMethodStyles(method);

    // eslint-disable-next-line no-console
    console.log(
      `%c${this.prefix}%c ${method}%c`,
      'color: #8b5cf6; font-weight: bold;',
      styles,
      'color: inherit;',
      `[${timestamp}]`,
      ...args
    );
  }

  /**
   * Get console styles for different methods
   */
  private getMethodStyles(method: string): string {
    switch (method) {
      case 'identify':
        return 'color: #06b6d4; font-weight: bold;';
      case 'track':
        return 'color: #10b981; font-weight: bold;';
      case 'page':
        return 'color: #f59e0b; font-weight: bold;';
      case 'reset':
        return 'color: #ef4444; font-weight: bold;';
      default:
        return 'color: #6b7280;';
    }
  }
}

/**
 * Create a console analytics provider
 *
 * @param config - Provider configuration
 * @returns Configured console provider
 */
export function createConsoleProvider(config?: ConsoleProviderConfig): ConsoleProvider {
  return new ConsoleProvider(config);
}
