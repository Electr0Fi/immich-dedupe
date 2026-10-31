import { useEffect, useState } from 'react';
import { ResolutionEditor } from '../components/ResolutionEditor';
import { hasStrictByteComparison, newRequirement } from '../resolutionUtils';
import { RULE_FIELDS, upgradeResolutionDraft, type ConfigurableRule, type ConfiguredDecision, type RuleCondition, type RuleSetDraft, type RulesState } from '@immich-dedupe/shared';
import { deleteRulePreset, getRules, publishRules, saveRulePreset, saveRulesDraft, testRules } from '../api';

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
export function RulesScreen({ snapshotId, disabled, onPublish }: { snapshotId: string | null; disabled: boolean; onPublish: () => void }) {
  const [state, setState] = useState<RulesState | null>(null);
  const [draft, setDraft] = useState<RuleSetDraft | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<ConfiguredDecision[] | null>(null);
  const [preset, setPreset] = useState('');
  const [presetName, setPresetName] = useState('');
  const [template, setTemplate] = useState('');
  useEffect(() => {
    let mounted = true;
    getRules().then((value) => { if (mounted) {
      setState(value); setDraft(value.draft); setTemplate(value.presets[0]?.id ?? '');
      const matching = value.savedPresets?.find((entry) => JSON.stringify(entry.ruleset) === JSON.stringify(value.draft));
      setPreset(matching?.id ?? ''); setPresetName(matching?.name ?? '');
    } })
      .catch((reason: unknown) => { if (mounted) setError(reason instanceof Error ? reason.message : 'Rules could not be loaded'); });
    return () => { mounted = false; };
  }, []);
  const busy = working || disabled;
  function edit(rules: ConfigurableRule[]) { if (!draft) return; setDraft(upgradeResolutionDraft({ ...draft, rules })); setResults(null); setMessage(null); }
  function update(index: number, rule: ConfigurableRule) { if (draft) edit(draft.rules.map((entry, position) => index === position ? rule : entry)); }
  function clone(rule: ConfigurableRule) {
    if (!draft) return;
    const current = rule.resolution ? rule : upgradeResolutionDraft({ schemaVersion: 1, rules: [rule] }).rules[0];
    edit([...draft.rules, { ...structuredClone(current), id: crypto.randomUUID(), name: `${rule.name} (copy)`, enabled: false }]);
  }
  function loadPreset(id: string) {
    const entry = state?.savedPresets?.find((item) => item.id === id);
    if (!entry) return;
    setPreset(entry.id); setPresetName(entry.name); setDraft(upgradeResolutionDraft(entry.ruleset));
    setResults(null); setError(null); setMessage(`Loaded preset “${entry.name}” into the editor. Publish rules to activate it.`);
  }
  function newPreset() {
    setPreset(''); setPresetName(''); setDraft({ schemaVersion: 2, rules: [] });
    setResults(null); setError(null); setMessage('New preset: enter a name and add rules below.');
  }
  async function refreshPresets() {
    if (busy) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const value = await getRules(); setState(value);
      if (!draft) {
        setDraft(value.draft); setTemplate(value.presets[0]?.id ?? '');
        const matching = value.savedPresets.find((entry) => JSON.stringify(entry.ruleset) === JSON.stringify(value.draft));
        setPreset(matching?.id ?? ''); setPresetName(matching?.name ?? '');
      } else {
        if (!value.savedPresets.some((entry) => entry.id === preset)) setPreset('');
      }
      setMessage('Preset list refreshed. The editor contents were kept.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Presets could not be refreshed'); }
    finally { setWorking(false); }
  }
  async function savePreset() {
    if (!draft || busy || !presetName.trim()) return;
    const name = presetName.trim();
    const existing = state?.savedPresets?.find((entry) => entry.name.trim().toLowerCase() === name.toLowerCase());
    if (!window.confirm(existing ? `Overwrite existing preset "${existing.name}" with the rules currently shown?` : `Save new preset as "${name}"?`)) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const value = await saveRulePreset({ name, ruleset: draft, ...(existing ? { overwriteId: existing.id, expectedRevision: existing.revision } : {}) });
      setState(value);
      const saved = value.savedPresets.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      setPreset(saved?.id ?? ''); setPresetName(saved?.name ?? name); setResults(null);
      setMessage(`Preset “${saved?.name ?? name}” saved. Publish rules to activate the editor contents.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Preset could not be saved'); }
    finally { setWorking(false); }
  }
  async function deletePreset() {
    const entry = state?.savedPresets?.find((item) => item.id === preset);
    if (busy || !entry || !window.confirm(`Delete preset "${entry.name}"? The rules currently shown and published rules will be kept.`)) return;
    setWorking(true); setError(null); setMessage(null);
    try {
      const value = await deleteRulePreset(entry.id, entry.revision);
      setState(value); setPreset(''); setPresetName('');
      setMessage(`Preset “${entry.name}” deleted. The editor contents and published rules were kept.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Preset could not be deleted'); }
    finally { setWorking(false); }
  }
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
    <section className="card rules-workflow" aria-labelledby="rules-workflow-title">
      <h2 id="rules-workflow-title">From candidate selection to resolution</h2>
      <p className="rules-workflow-path">Select groups → Review proposed resolution → Dry-run → Execute</p>
      <p>Immich supplies the duplicate groups. Stage 1 decides which groups qualify for review; Stage 2 defines how included groups would be resolved.</p>
      <p>Including a group does not execute changes. Saving presets, saving drafts and publishing rules do not resolve duplicates. Review the proposed resolution on Dedupe, complete a successful dry-run, then explicitly execute the selection.</p>
    </section>
    <section className="card"><h2>Active rules and draft</h2>
      <p><strong>Save draft</strong> stores your current edits so you can return to them later. Active rules used for duplicate reviews stay unchanged.</p>
      <p><strong>Publish rules</strong> saves and activates the rules currently shown in the editor for new reviews. Publishing clears the current review and its dry-run approval; prepare a new review and complete a new dry-run before execution. You can publish directly without saving a draft first.</p>
      <p>Only two unlinked images are supported. Favorites, archived, offline, edited and trashed assets remain protected. Missing safety information prevents inclusion. AI similarity alone never qualifies.</p>
      {state && <p className="run-identifier">Active revision: {state.active.revision}</p>}
      {state?.requiresResolutionUpgrade && <p className="resolution-notice">Your presets and draft were converted to equivalent AND/OR requirements. Review and publish the updated draft before preparing new reviews. Previously published rules and historical evidence were preserved.</p>}
      {error && <p className="error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      {!draft ? error ? <button disabled={busy} onClick={refreshPresets}>Retry loading rules</button> : <p>Loading rules…</p> : <>
        <div className="buttonRow"><button disabled={busy} onClick={() => act('save')}>Save draft</button><button disabled={busy} onClick={() => act('publish')}>Publish rules</button><button disabled={busy || !snapshotId} onClick={() => act('test')}>Test draft against prepared review</button></div>
        {!snapshotId && <p className="field-hint">Prepare a review on Dedupe to test this draft against its snapshot.</p>}
        <fieldset className="rule-presets" disabled={busy}><legend>Saved presets</legend>
          <div className="controls"><label>Preset<select aria-label="Preset" value={preset} onChange={(event) => loadPreset(event.target.value)}>
            <option value="" disabled>Current editor / unsaved preset</option>
            {state?.savedPresets?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label><label>Preset name<input value={presetName} maxLength={100} onChange={(event) => setPresetName(event.target.value)} /></label></div>
          <div className="buttonRow"><button onClick={newPreset}>New preset</button><button disabled={!presetName.trim()} onClick={savePreset}>Save preset</button><button disabled={!preset} onClick={deletePreset}>Delete preset</button><button onClick={refreshPresets}>Refresh presets</button></div>
          <p className="field-hint">Presets contain every rule, its settings and order. Selecting a preset replaces the editor contents. Save your changes before switching. A new name saves a separate preset; an existing name asks to overwrite. Saving or deleting a preset does not publish rules.</p>
        </fieldset>
        <div className="controls"><label>Rule template<select aria-label="Rule template" disabled={busy} value={template} onChange={(event) => setTemplate(event.target.value)}>{state?.presets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button disabled={busy || !template} onClick={() => { const entry = state?.presets.find((item) => item.id === template); if (entry) clone(entry); }}>Add rule from template</button></div>
        <p>Rules run in order; the first matching rule wins. An earlier rule with missing required information defers the group. Draft changes apply only after publishing.</p>
        {draft.rules.map((rule, index) => <article className="rule-editor" key={rule.id}>
          <div className="rule-heading"><h3>Rule {index + 1}</h3>
            <label className="rule-enabled"><span>Enabled</span><input className="rule-switch" type="checkbox" role="switch" disabled={busy} checked={rule.enabled} onChange={(event) => update(index, { ...rule, enabled: event.target.checked })} /></label>
          </div>
          <div className="controls rule-main-controls"><label className="rule-name">Name<input disabled={busy} value={rule.name} onChange={(event) => update(index, { ...rule, name: event.target.value })} /></label></div>
          <section className="rule-stage" aria-labelledby={`rule-selection-${index}`}>
            <h4 id={`rule-selection-${index}`}>1. Select candidate groups</h4>
            <p>Determine whether an Immich duplicate group qualifies for review using comparisons and conditions.</p>
            <div className="controls rule-main-controls"><label>Candidate decision<select aria-label="Candidate decision" disabled={busy} value={rule.action} onChange={(event) => update(index, { ...rule, action: event.target.value as ConfigurableRule['action'] })}><option value="include">Include group</option><option value="exclude">Exclude group</option></select></label>
            <label>Comparison evidence<select aria-label="Comparison evidence" disabled={busy} value={rule.comparison} onChange={(event) => update(index, { ...rule, comparison: event.target.value as ConfigurableRule['comparison'], acknowledgeHeuristic: false })}><option value="checksum">Checksum match</option><option value="metadata">Metadata match (heuristic)</option></select></label></div>
            {rule.comparison === 'metadata' && <label className="toggle-row"><input type="checkbox" disabled={busy} checked={rule.acknowledgeHeuristic} onChange={(event) => update(index, { ...rule, acknowledgeHeuristic: event.target.checked })} /><span>I accept that metadata matching can include genuinely different images, even when filenames match. This does not prove identical content.</span></label>}
            <p className="field-hint">Conditions referring to the proposed keeper or loser use the resolution requirements in Stage 2.</p>
            <ConditionEditor value={rule.conditions} onChange={(conditions) => update(index, { ...rule, conditions })} disabled={busy} />
          </section>
          <section className="rule-stage" aria-labelledby={`rule-resolution-${index}`}>
            <h4 id={`rule-resolution-${index}`}>2. Define group resolution</h4>
            {rule.action === 'exclude' ? <p>Excluded groups are not resolved. Any stored resolution requirements are retained, including for conditions that reference the proposed keeper or loser, and are shown again when you switch to Include group.</p> : <>
              <p>For included groups, these preferences define the proposed keeper. The other asset will be trashed during execution. Missing required information defers the group; no unique match excludes it.</p>
              <p>Keep an asset only when its requirements match uniquely. AND requires every condition; OR accepts any branch but does not assign priority. If neither or both assets qualify, exclude and flag the group.</p>
              <ResolutionEditor value={rule.resolution ?? { all: [newRequirement()] }} onChange={(resolution) => update(index, { ...rule, keeperPreferences: [], resolution })} disabled={busy} />
              {rule.comparison === 'checksum' && rule.resolution && hasStrictByteComparison(rule.resolution) && <p className="field-hint">Matching checksums require equal file sizes. A strictly larger byte-size requirement cannot match them; in an AND group it prevents inclusion. File size and resolution are different comparisons.</p>}
              <p className="field-hint">When no unique asset matches: Exclude and flag. No fallback or override is applied.</p>
              <div className="rule-resolution-safeguards">
                <h5>Album preservation <span className="rule-policy-badge">Always applied</span></h5>
                <ol>
                  <li>Add the keeper to any visible albums containing the other asset where the keeper is missing.</li>
                  <li>Verify the keeper belongs to every required album before proceeding.</li>
                  <li>Resolve the duplicate in Immich, keeping the chosen asset and trashing the other.</li>
                  <li>Verify the other asset is trashed and removed from the duplicate group, and the keeper remains untrashed.</li>
                </ol>
                <p className="field-hint">These safeguards are mandatory. Execution takes place on Dedupe after review, a successful dry-run and explicit execution.</p>
              </div>
            </>}
          </section>
          <div className="buttonRow"><button disabled={busy || index === 0} onClick={() => { const next = [...draft.rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; edit(next); }}>Move rule up</button><button disabled={busy || index === draft.rules.length - 1} onClick={() => { const next = [...draft.rules]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; edit(next); }}>Move rule down</button><button disabled={busy} onClick={() => clone(rule)}>Clone rule</button><button disabled={busy} onClick={() => edit(draft.rules.filter((_, position) => position !== index))}>Remove rule</button></div>
        </article>)}
      </>}
    </section>
    {results && <section className="card"><h2>Draft test results</h2><p>Snapshot values only; missing data is not fetched. No assets were changed.</p>{results.length === 0 && <p>No candidate groups in this snapshot to test.</p>}{results.map((decision) => <details key={decision.groupId}><summary>Group {decision.groupId}: {decision.outcome} · {decision.evidenceClass === 'checksum' ? 'Checksum match' : decision.evidenceClass === 'metadata' ? 'Metadata match' : 'Unverified'}</summary><p>Rule: {decision.matchedRuleName ?? 'None'}</p><ul>{decision.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{decision.missingFields.length > 0 && <p>Missing: {decision.missingFields.join(', ')}</p>}<pre>{JSON.stringify(decision.observedValues, null, 2)}</pre></details>)}</section>}
  </div>;
}
