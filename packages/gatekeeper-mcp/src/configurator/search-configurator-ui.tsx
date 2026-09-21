import { CheckboxList, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc, McpServerConfiguratorValues,
} from "./server-configurator-types";

export default {
  initial: { mode: "choose", tools: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const tools = new URLSearchParams(new URL(resourceUrl).hash.slice(1)).getAll("tool")
      .map(name => name.trim()).filter(Boolean).map(encodeURIComponent);
    return { mode: "choose", tools: tools.length ? tools.join(",") : null };
  },

  isReady({ values }) {
    return (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    const endpoint = await ui.getEndpoint();
    const params = new URLSearchParams();
    const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
      .map(decodeURIComponent);
    for (const tool of selected) params.append("tool", tool);
    if (selected.length === 0) params.append("tool", "");
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Personal search tools" description={
        "Select the search tool to allow. Calls use your connected provider account's credits. " +
        "No platform-paid fallback. Other tools, including future tools, are refused. " +
        "Page scraping is unavailable until its parser cost controls are verified."
      }>
        <CheckboxList
          name="tools"
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions())
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          onChange={tools => setValues({ tools })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
