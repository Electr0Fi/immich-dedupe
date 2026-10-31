import { newRequirement } from '../resolutionUtils';
import { RULE_FIELDS, type ResolutionCondition, type RuleField } from '@immich-dedupe/shared';
const numeric = new Set(['fileSize','width','height','pixelCount','aspectRatio','exif.orientation','exif.fNumber','exif.iso','exif.rating']);
const dates = new Set(['takenAt','fileCreatedAt','fileModifiedAt']);
const labels: Partial<Record<RuleField,string>> = { originalPath: 'Directory', fileSize: 'File size (bytes)', pixelCount: 'Resolution (pixel count)' };
export function ResolutionEditor({ value, onChange, disabled, depth = 0 }: { value: ResolutionCondition; onChange: (value: ResolutionCondition) => void; disabled: boolean; depth?: number }) {
  if ('all' in value || 'any' in value) {
    const all = 'all' in value, children = all ? value.all : value.any;
    const update = (next: ResolutionCondition[]) => onChange(all ? { all: next } : { any: next });
    return <fieldset className="rule-condition" disabled={disabled}><legend>Keeper requirements</legend>
      <label>Match<select aria-label="Resolution match" value={all ? 'all' : 'any'} onChange={(event) => onChange(event.target.value === 'all' ? { all: children } : { any: children })}><option value="all">ALL requirements (AND)</option><option value="any">ANY requirement (OR)</option></select></label>
      {children.map((child,index) => <div className="rule-condition-child" key={index}><ResolutionEditor value={child} disabled={disabled} depth={depth+1} onChange={(next) => update(children.map((entry,i) => i === index ? next : entry))} /><button type="button" onClick={() => update(children.filter((_,i) => i !== index))}>Remove requirement {index+1}</button></div>)}
      <div className="buttonRow"><button type="button" disabled={children.length >= 32} onClick={() => update([...children,newRequirement()])}>Add requirement</button><button type="button" disabled={depth >= 3 || children.length >= 32} onClick={() => update([...children,{ all: [newRequirement()] }])}>Add requirement group</button></div>
    </fieldset>;
  }
  const field = 'preference' in value ? value.preference.field === 'directory' ? 'directoryPriority' : value.preference.field : value.field;
  function changeField(field: string) {
    if (field === 'directoryPriority') onChange({ preference: { field: 'directory', direction: 'lowest', directories: [] }, operator: 'better' });
    else onChange({ field: field as RuleField, operator: field === 'originalPath' ? 'prefix' : numeric.has(field) || dates.has(field) ? 'gt' : 'eq', ...(field === 'originalPath' ? { value: '', includeSubdirectories: true } : numeric.has(field) || dates.has(field) ? { compareTo: 'other' as const } : { value: '' }) });
  }
  return <fieldset className="rule-condition" disabled={disabled}>
    <div className="controls rule-main-controls"><label>Requirement field<select aria-label="Requirement field" value={field} onChange={(event) => changeField(event.target.value)}><option value="directoryPriority">Directory priority (converted preference)</option>{RULE_FIELDS.map((entry) => <option key={entry} value={entry}>{labels[entry] ?? entry}</option>)}</select></label>
    {'preference' in value ? <>
      <label>Compare<select aria-label="Relative requirement" value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as 'better' | 'tied' })}><option value="better">Ranks better than the other asset</option><option value="tied">Tied with the other asset</option></select></label>
      {value.preference.field !== 'directory' && <label>Better means<select aria-label="Better means" value={value.preference.direction} onChange={(event) => onChange({ ...value, preference: { ...value.preference, direction: event.target.value as 'highest' | 'lowest' } })}><option value="highest">Higher / newer</option><option value="lowest">Lower / older</option></select></label>}
    </> : <>
      <label>Comparison<select aria-label="Resolution comparison" value={value.operator} onChange={(event) => { const operator = event.target.value as typeof value.operator; onChange({ field: value.field, operator, ...(['missing','same','different'].includes(operator) ? {} : ['prefix','glob','between','within'].includes(operator) ? { value: operator === 'between' ? [0,0] as [number,number] : operator === 'within' ? 0 : '', ...(value.field === 'originalPath' && operator === 'prefix' ? { includeSubdirectories: true } : {}) } : { compareTo: 'other' as const }) }); }}>
        <option value="eq">Equals</option><option value="ne">Does not equal</option>{(numeric.has(value.field) || dates.has(value.field)) && <><option value="gt">Greater than</option><option value="gte">At least</option><option value="lt">Less than</option><option value="lte">At most</option></>}{numeric.has(value.field) && <option value="between">Between</option>}{!numeric.has(value.field) && !dates.has(value.field) && <><option value="prefix">In directory / prefix</option><option value="glob">Matches pattern</option></>}<option value="missing">Missing</option><option value="same">Same as the other asset</option><option value="different">Different from the other asset</option>{dates.has(value.field) && <option value="within">Within tolerance (seconds)</option>}
      </select></label>
      {!['missing','same','different','prefix','glob','between','within'].includes(value.operator) && <label>Compare against<select aria-label="Compare against" value={value.compareTo ?? 'value'} onChange={(event) => { onChange({ field: value.field, operator: value.operator, ...(event.target.value === 'other' ? { compareTo: 'other' as const } : { value: numeric.has(value.field) ? 0 : '' }) }); }}><option value="other">The other asset</option><option value="value">A value</option></select></label>}
      {!value.compareTo && !['missing','same','different'].includes(value.operator) && <label>Required value<input aria-label="Required value" value={Array.isArray(value.value) ? value.value.join(', ') : value.value ?? ''} onChange={(event) => onChange({ ...value, value: value.operator === 'between' ? event.target.value.split(',').map(Number).slice(0,2) as [number,number] : numeric.has(value.field) || value.operator === 'within' ? Number(event.target.value) : event.target.value })} /></label>}
    </>}
    </div>
    {'preference' in value && value.preference.field === 'directory' && <label>Directories, preferred first (one per line)<textarea rows={3} value={value.preference.directories?.join('\n') ?? ''} onChange={(event) => onChange({ ...value, preference: { ...value.preference, directories: event.target.value.split('\n') } })} /></label>}
    {'field' in value && value.field === 'originalPath' && value.operator === 'prefix' && <label className="review-selection"><input type="checkbox" checked={value.includeSubdirectories !== false} onChange={(event) => onChange({ ...value, includeSubdirectories: event.target.checked })} />Include subdirectories</label>}
  </fieldset>;
}
