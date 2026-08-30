import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WorkersAiModelConfiguratorRpc,
  WorkersAiModelConfiguratorValues,
} from "./model-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.modelId === "string" && values.modelId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.modelId);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const marker = "/_resource/model/";
    const index = new URL(resourceUrl).pathname.indexOf(marker);
    if (index < 0) return {};
    try {
      const encoded = new URL(resourceUrl).pathname.slice(index + marker.length);
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padding = "=".repeat((4 - normalized.length % 4) % 4);
      const binary = atob(normalized + padding);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return { modelId: new TextDecoder().decode(bytes) };
    } catch {
      return {};
    }
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Workers AI model"
        description="Choose one embeddings, image, speech, or classification model. Text-generation models are added from Providers.">
        <Autocomplete
          name="modelId"
          value={values.modelId}
          placeholder="Search Workers AI models..."
          loadOptions={query => ui.listModels(query)}
          onChange={modelId => setValues({ modelId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkersAiModelConfiguratorRpc, WorkersAiModelConfiguratorValues>;
