import { useTranslation } from 'react-i18next';
import type { McpServerView, ModelProviderView } from '@worklite/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ConfigurationProps = {
  providers: ModelProviderView[];
  mcpServers: McpServerView[];
  selection: string;
  onSelectionChange: (value: string) => void;
  selectedMcpServerIds: string[];
  onMcpServersChange: (ids: string[]) => void;
  saving: boolean;
};

function Configuration({ providers, mcpServers, selection, onSelectionChange, selectedMcpServerIds, onMcpServersChange, saving }: ConfigurationProps) {
  const { t } = useTranslation('assistant');
  return (
    <form className="agent-config-form" onSubmit={(event) => event.preventDefault()}>
      <div className="agent-config-scroll">
        <section className="agent-config-section">
          <div className="agent-config-heading">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-info">Chat Bot</span>
            <h3>{t('configuration.title')}</h3>
            <p>{t('configuration.description')}</p>
          </div>
          <div className="agent-config-fields">
            <label className="config-field" htmlFor="assistant-model-selection">
              <span>{t('configuration.model')}</span>
              <Select value={selection} onValueChange={onSelectionChange}>
                <SelectTrigger id="assistant-model-selection"><SelectValue placeholder={t('configuration.placeholder')} /></SelectTrigger>
                <SelectContent>
                  {providers.flatMap((provider) => (provider.models ?? []).map((model) => (
                    <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>
                  )))}
                </SelectContent>
              </Select>
              {saving ? <small>{t('configuration.saving')}</small> : null}
            </label>
            <fieldset className="config-field">
              <legend>{t('configuration.mcpServers')}</legend>
              <div className="space-y-2">
                {mcpServers.map((server: McpServerView) => (
                  <label key={server.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedMcpServerIds.includes(server.id)}
                      onChange={(event) => onMcpServersChange(event.target.checked
                        ? [...selectedMcpServerIds, server.id]
                        : selectedMcpServerIds.filter((id) => id !== server.id))}
                    />
                    {server.name}
                  </label>
                ))}
              </div>
              <small>{t('configuration.mcpServersHint')}</small>
            </fieldset>
          </div>
        </section>
      </div>
    </form>
  );
}

export { Configuration };
