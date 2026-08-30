/** One selectable Workers AI model shown in the resource picker. */
export type WorkersAiConfiguratorOption = {
  /** Exact Workers AI model identifier. */
  value: string;

  /** Human-readable model name. */
  title: string;

  /** Model task, such as Text Embeddings or Text-to-Image. */
  subtitle?: string;

  /** Optional provider or lifecycle metadata. */
  meta?: string;
};

/** Editable values owned by the Workers AI model configurator. */
export type WorkersAiModelConfiguratorValues = {
  /** Exact model identifier selected by the user. */
  modelId?: string | null;
};

/** Narrow RPC API available to the sandboxed Workers AI model configurator. */
export interface WorkersAiModelConfiguratorRpc {
  /** Search the connected account's supported non-chat models. */
  listModels(query: string): Promise<WorkersAiConfiguratorOption[]>;

  /** Convert one exact model identifier into its canonical binding URL. */
  resourceUrl(modelId: string | null | undefined): Promise<string>;
}
