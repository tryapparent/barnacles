System.register(['react', '@grafana/data', '@grafana/runtime', '@grafana/ui'], function (exports) {
  let React;
  let DataSourcePlugin;
  let DataSourceWithBackend;
  let getTemplateSrv;
  let InlineField;
  let Input;

  function QueryEditor({ query, onChange, onRunQuery }) {
    const inputId = React.useId();
    return React.createElement(
      InlineField,
      { label: 'Run ID', htmlFor: inputId, grow: true, required: true },
      React.createElement(Input, {
        id: inputId,
        value: query.runId ?? '',
        maxLength: 128,
        required: true,
        onChange: (event) => onChange({ ...query, runId: event.currentTarget.value }),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onRunQuery();
          }
        },
      })
    );
  }

  return {
    setters: [
      (module) => { React = module; },
      (module) => { DataSourcePlugin = module.DataSourcePlugin; },
      (module) => {
        DataSourceWithBackend = module.DataSourceWithBackend;
        getTemplateSrv = module.getTemplateSrv;
      },
      (module) => {
        InlineField = module.InlineField;
        Input = module.Input;
      },
    ],
    execute() {
      class DataSource extends DataSourceWithBackend {
        applyTemplateVariables(query, scopedVars) {
          return { ...query, runId: getTemplateSrv().replace(query.runId ?? '', scopedVars) };
        }
      }

      exports('plugin', new DataSourcePlugin(DataSource).setQueryEditor(QueryEditor));
    },
  };
});
