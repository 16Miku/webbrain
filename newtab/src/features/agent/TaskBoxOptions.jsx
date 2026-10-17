import variables from 'config/variables';

import { Header, Row, Content, Action } from 'components/Layout/Settings';
import { Dropdown, Switch } from 'components/Form/Settings';
import { canSearch } from './handoff';

function TaskBoxOptions() {
  const modes = [
    { value: 'ask', text: variables.getMessage('wb.ask') },
    { value: 'act', text: variables.getMessage('wb.act') },
    ...(canSearch() ? [{ value: 'search', text: variables.getMessage('wb.search') }] : []),
  ];

  return (
    <>
      <Header
        title={variables.getMessage('wb.settings_taskbox')}
        setting="taskBox"
        category="widgets"
      />
      <Row>
        <Content
          title={variables.getMessage('wb.settings_default_mode')}
          subtitle={variables.getMessage('wb.settings_taskbox_sub')}
        />
        <Action>
          <Dropdown name="taskBoxMode" category="widgets" items={modes} />
        </Action>
      </Row>
      <Row final>
        <Content title={variables.getMessage('wb.settings_recent')} />
        <Action>
          <Switch name="recentChats" element=".other" />
        </Action>
      </Row>
    </>
  );
}

export { TaskBoxOptions as default, TaskBoxOptions };
