/**
 * Model registry — holds all registered providers and delegates selection.
 *
 * Delegates model selection to a ModelSelector (e.g. APIPoolManager) so the
 * registry itself is selection-strategy agnostic.
 */

import type { ModelSelector } from "../routing/protocol.ts";
import type { ModelConfig, ModelProvider } from "./protocol.ts";
import { makeModelConfig } from "./protocol.ts";

export class ModelRegistry {
  private _providers: Map<string, ModelProvider> = new Map();
  private _configs: Map<string, ModelConfig> = new Map();
  private _aliases: Map<string, string> = new Map();

  constructor(private _selector: ModelSelector) {}

  // -- Provider management --

  /** Register a model provider under its canonical name.
   *
   * If config is provided, it is stored as the default ModelConfig for this
   * api_id (used by buildConfig).
   */
  register(
    name: string,
    provider: ModelProvider,
    opts: { config?: ModelConfig } = {},
  ): void {
    this._providers.set(name, provider);
    if (opts.config) this._configs.set(name, opts.config);
  }

  /** Create a short alias for a model name (e.g. 'opus' -> 'anthropic/claude-opus-4-6'). */
  alias(alias: string, target: string): void {
    if (!this._providers.has(target)) {
      throw new Error(`cannot alias to unknown provider: ${JSON.stringify(target)}`);
    }
    this._aliases.set(alias, target);
  }

  /** Look up a provider by name or alias. Throws if not found. */
  get(name: string): ModelProvider {
    const resolved = this._aliases.get(name) ?? name;
    const provider = this._providers.get(resolved);
    if (!provider) throw new Error(`unknown model: ${JSON.stringify(name)}`);
    return provider;
  }

  /** Return all registered canonical names. */
  list(): string[] {
    return [...this._providers.keys()].sort();
  }

  // -- Selection --

  /** Select a model for the given task_type via the configured selector. */
  select(task_type: string, override?: string | null): string {
    return this._selector.select(task_type, override);
  }

  // -- Convenience --

  /** Build a ModelConfig for the given api_id.
   *
   * Uses the stored default config if available, overridden by `overrides`.
   */
  buildConfig(api_id: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
    const base = this._configs.get(api_id) ?? makeModelConfig({ model: api_id });
    return { ...base, ...overrides };
  }
}
