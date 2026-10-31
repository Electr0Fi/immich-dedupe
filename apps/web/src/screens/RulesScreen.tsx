import { useEffect, useState } from 'react';
import { RULE_FIELDS, type ConfigurableRule, type ConfiguredDecision, type KeeperPreference, type RuleCondition, type RuleSetDraft, type RulesState } from '@immich-dedupe/shared';
import { getRules, publishRules, saveRulesDraft, testRules } from '../api';

const NUMERIC_FIELDS = new Set(['fileSize', 'width', 'height', 'pixelCount', 'aspectRatio', 'exif.orientation', 'exif.fNumber', 'exif.iso', 'exif.rating']);
const DATE_FIELDS = new Set(['takenAt', 'fileCreatedAt', 'fileModifiedAt']);
const freshCondition = (): RuleCondition => ({ field: 'fileName', operator: 'same' });
function ConditionEditor({ value, onChange, disabled, depth = 0 }: { value: RuleCondition; onChange: (next: RuleCondition) => void; disabled: boolean; depth?: number }) {
  if ('all' in value || 'any' in value) {
    const mode = 'all' in value ? 'all' : 'any';
    const children = 'all' in value ? value.all : value.any;
    return <fieldset className="rule-condition" disabled={disabled}>
      <legend>Condition group</legend>
      <label>Match<select aria-label="Condition group match" value={mode} onChange={(event) => onChange(event.target.value === 'all' ? { all: children } : { any: children })}><option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option></select></label>
      {children.map((child, index) => <div className="rule-condition-child" key={index}>
        <ConditionEditor value={child} disabled={disabled} depth={depth + 1} onChange={(next) => onChange({ [mode]: children.map((entry, childIndex) => childIndex === index ? next : entry) } as RuleCondition)} />
        <button type="button" onClick={() => onChange({ [mode]: children.filter((_, childIndex) => childIndex !== index) } as RuleCondition)}>Remove condition {index + 1}</button>
      </div>)}
      <div className="buttonRow"><button type="button" disabled={children.length >= 20} onClick={() => onChange({ [mode]: [...children, freshCondition()] } as RuleCondition)}>Add condition</button>
        <button type="button" disabled={depth >= 3 || children.length >= 20} onClick={() => onChange({ [mode]: [...children, { all: [freshCondition()] }] } as RuleCondition)}>Add condition group</button></div>
    </fieldset>;
  }
  const noValue = ['same', 'different', 'missing'].includes(value.operator);
  return <fieldset className="rule-condition controls" disabled={disabled}>
    <label>Field<select aria-label="Field" value={value.field} onChange={(event) => onChange({ ...value, field: event.target.value as typeof value.field, operator: 'same', value: undefined })}>{RULE_FIELDS.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>
    <label>Comparison<select aria-label="Comparison" value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as typeof value.operator, value: undefined })}>
      <option value="same">Same across both assets</option><option value="different">Different across assets</option><option value="eq">Equals</option><option value="ne">Does not equal</option>{(NUMERIC_FIELDS.has(value.field) || DATE_FIELDS.has(value.field)) && <><option value="gt">Greater than</option><option value="gte">At least</option><option value="lt">Less than</option><option value="lte">At most</option></>}{NUMERIC_FIELDS.has(value.field) && <option value="between">Between (min, max)</option>}{!NUMERIC_FIELDS.has(value.field) && !DATE_FIELDS.has(value.field) && <><option value="prefix">Prefix</option><option value="glob">Glob pattern</option></>}<option value="missing">Missing</option>{DATE_FIELDS.has(value.field) && <option value="within">Within tolerance</option>}
    </select></label>
    {!noValue && <><label>Apply to<select aria-label="Apply to" value={value.target ?? 'all'} onChange={(event) => onChange({ ...value, target: event.target.value as typeof value.target })}><option value="all">Both assets</option><option value="any">Either asset</option><option value="keeper">Proposed keeper</option><option value="trash">Proposed loser</option></select></label>
      <label>{value.operator === 'within' ? 'Tolerance (seconds)' : 'Value'}<input value={Array.isArray(value.value) ? value.value.join(', ') : value.value ?? ''} onChange={(event) => {
        const input = event.target.value;
        const next = input === '' ? undefined : value.operator === 'between' ? input.split(',').map(Number).slice(0, 2) as [number, number] : NUMERIC_FIELDS.has(value.field) || value.operator === 'within' ? Number(input) : input;
        onChange({ ...value, value: next });
      }} /></label></>}
  </fieldset>;
}
function KeeperEditor({ preferences, onChange, disabled }: { preferences: KeeperPreference[]; onChange: (next: KeeperPreference[]) => void; disabled: boolean }) {
  function update(index: number, next: KeeperPreference) { onChange(preferences.map((entry, position) => position === index ? next : entry)); }
  return <fieldset disabled={disabled} className="keeper-preferences"><legend>Keeper preferences, in priority order</legend>
    <p>Choose the copy in directory A before directory B. Directory matching respects path boundaries. If every preference ties, the group is excluded.</p>
    {preferences.map((preference, index) => <div className="rule-condition" key={index}>
      <div className="controls"><label>Preference {index + 1}<select value={preference.field} onChange={(event) => update(index, { field: event.target.value as KeeperPreference['field'], direction: preference.direction, ...(event.target.value === 'directory' ? { directories: [] } : {}) })}>
        <option value="directory">Directory order</option><option value="fileSize">File size</option><option value="pixelCount">Resolution (pixel count)</option><option value="takenAt">Capture date</option><option value="fileModifiedAt">Modified date</option>
      </select></label>
      {preference.field !== 'directory' && <label>Prefer<select aria-label="Prefer" value={preference.direction} onChange={(event) => update(index, { ...preference, direction: event.target.value as KeeperPreference['direction'] })}><option value="highest">Highest / newest</option><option value="lowest">Lowest / oldest</option></select></label>}</div>
      {preference.field === 'directory' && <label>Directories, preferred first (one per line)<textarea rows={3} value={(preference.directories ?? []).join('\n')} onChange={(event) => update(index, { ...preference, directories: event.target.value.split('\n') })} placeholder={'/photos/originals\n/photos/copies'} /></label>}
      <div className="buttonRow"><button type="button" disabled={index === 0} onClick={() => { const next = [...preferences]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>Move preference up</button><button type="button" onClick={() => onChange(preferences.filter((_, position) => position !== index))}>Remove preference</button></div>
    </div>)}
    <button type="button" onClick={() => onChange([...preferences, { field: 'directory', direction: 'lowest', directories: [] }])}>Add keeper preference</button>
  </fieldset>;
}

export function RulesScreen({ snapshotId, disabled, onPublish }: { snapshotId: string | null; disabled: boolean; onPublish: () => void }) {
  const [state, setState] = useState<RulesState | null>(null);
  const [draft, setDraft] = useState<RuleSetDraft | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<ConfiguredDecision[] | null>(null);
  const [preset, setPreset] = useState('');
  useEffect(() => {
    let mounted = true;
    getRules().then((value) => { if (mounted) { setState(value); setDraft(value.draft); setPreset(value.presets[0]?.id ?? ''); } })
      .catch((reason: unknown) => { if (mounted) setError(reason instanceof Error ? reason.message : 'Rules could not be loaded'); });
    return () => { mounted = false; };
  }, []);
  const busy = working || disabled;
  function edit(rules: ConfigurableRule[]) { if (!draft) return; setDraft({ ...draft, rules }); setResults(null); setMessage(null); }
  function update(index: number, rule: ConfigurableRule) { if (draft) edit(draft.rules.map((entry, position) => index === position ? rule : entry)); }
  function clone(rule: ConfigurableRule) { if (draft) edit([...draft.rules, { ...structuredClone(rule), id: crypto.randomUUID(), name: `${rule.name} (copy)`, enabled: false }]); }
  async function act(action: 'save' | 'publish' | 'test') {
    if (!draft || busy) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      if (action === 'test') {
        if (!snapshotId) return;
        const response = await testRules(draft, snapshotId); setResults(response.results);
        setMessage('Draft evaluated against the prepared snapshot only. This does not authorize execution.');
      } else {
        const value = await (action === 'publish' ? publishRules(draft) : saveRulesDraft(draft)); setState(value); setDraft(value.draft);
        setResults(null);
        if (action === 'publish') { onPublish(); setMessage('Rules published. Prepare a new review and dry-run; earlier approvals are no longer valid.'); }
        else setMessage('Draft saved. Active rules have not changed.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Rules could not be updated'); }
    finally { setWorking(false); }
  }
  return <div><header className="screen-header"><h1>Rules</h1><p>Configure comparisons and choose which directory’s copy to keep.</p></header>
    <section className="card"><h2>Active rules and draft</h2>
      <p>Only two unlinked images are supported. Favorites, archived, offline, edited and trashed assets remain protected. Missing safety information prevents inclusion. AI similarity alone never qualifies.</p>
      {state && <p className="run-identifier">Active revision: {state.active.revision}</p>}
      {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      {!draft ? <p>Loading rules…</p> : <>
        <div className="buttonRow"><button disabled={busy} onClick={() => act('save')}>Save draft</button><button disabled={busy} onClick={() => act('publish')}>Publish rules</button><button disabled={busy || !snapshotId} onClick={() => act('test')}>Test draft against prepared review</button></div>
        {!snapshotId && <p className="field-hint">Prepare a review on Dedupe to test this draft against its snapshot.</p>}
        <div className="controls"><label>Preset<select aria-label="Preset" disabled={busy} value={preset} onChange={(event) => setPreset(event.target.value)}>{state?.presets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button disabled={busy || !preset} onClick={() => { const entry = state?.presets.find((item) => item.id === preset); if (entry) clone(entry); }}>Add preset copy</button></div>
        <p>Rules run in order; the first matching rule wins. An earlier rule with missing required information defers the group. Draft changes apply only after publishing.</p>
        {draft.rules.map((rule, index) => <article className="rule-editor" key={rule.id}>
          <h3>Rule {index + 1}</h3>
          <div className="controls"><label>Name<input disabled={busy} value={rule.name} onChange={(event) => update(index, { ...rule, name: event.target.value })} /></label>
            <label className="review-selection"><input type="checkbox" disabled={busy} checked={rule.enabled} onChange={(event) => update(index, { ...rule, enabled: event.target.checked })} />Enabled</label>
            <label>Action<select aria-label="Action" disabled={busy} value={rule.action} onChange={(event) => update(index, { ...rule, action: event.target.value as ConfigurableRule['action'] })}><option value="include">Include group</option><option value="exclude">Exclude group</option></select></label>
            <label>Comparison evidence<select aria-label="Comparison evidence" disabled={busy} value={rule.comparison} onChange={(event) => update(index, { ...rule, comparison: event.target.value as ConfigurableRule['comparison'], acknowledgeHeuristic: false })}><option value="checksum">Checksum match</option><option value="metadata">Metadata match (heuristic)</option></select></label></div>
          {rule.comparison === 'metadata' && <label className="toggle-row"><input type="checkbox" disabled={busy} checked={rule.acknowledgeHeuristic} onChange={(event) => update(index, { ...rule, acknowledgeHeuristic: event.target.checked })} /><span>I accept that metadata matching can include genuinely different images, even when filenames match. This does not prove identical content.</span></label>}
          <ConditionEditor value={rule.conditions} onChange={(conditions) => update(index, { ...rule, conditions })} disabled={busy} />
          <KeeperEditor preferences={rule.keeperPreferences} onChange={(keeperPreferences) => update(index, { ...rule, keeperPreferences })} disabled={busy} />
          <div className="buttonRow"><button disabled={busy || index === 0} onClick={() => { const next = [...draft.rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; edit(next); }}>Move rule up</button><button disabled={busy || index === draft.rules.length - 1} onClick={() => { const next = [...draft.rules]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; edit(next); }}>Move rule down</button><button disabled={busy} onClick={() => clone(rule)}>Clone rule</button><button disabled={busy} onClick={() => edit(draft.rules.filter((_, position) => position !== index))}>Remove rule</button></div>
        </article>)}
      </>}
    </section>
    {results && <section className="card"><h2>Draft test results</h2><p>Snapshot values only; missing data is not fetched. No assets were changed.</p>{results.length === 0 && <p>No candidate groups in this snapshot to test.</p>}{results.map((decision) => <details key={decision.groupId}><summary>Group {decision.groupId}: {decision.outcome} · {decision.evidenceClass === 'checksum' ? 'Checksum match' : decision.evidenceClass === 'metadata' ? 'Metadata match' : 'Unverified'}</summary><p>Rule: {decision.matchedRuleName ?? 'None'}</p><ul>{decision.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{decision.missingFields.length > 0 && <p>Missing: {decision.missingFields.join(', ')}</p>}<pre>{JSON.stringify(decision.observedValues, null, 2)}</pre></details>)}</section>}
  </div>;
}
