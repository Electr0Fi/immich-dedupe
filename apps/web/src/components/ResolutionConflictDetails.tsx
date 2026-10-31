import type { ResolutionAssessment } from '@immich-dedupe/shared';
export function ResolutionConflictDetails({ assessment, ruleName }: { assessment: ResolutionAssessment; ruleName?: string | null }) {
  return <div className="resolution-conflict-details"><p><strong>{assessment.status === 'ambiguous' ? 'Both assets meet the requirements; keeper selection is ambiguous.' : assessment.status === 'unverified' ? 'Missing information prevents a unique keeper.' : 'No asset meets the resolution requirements.'}</strong></p>
    {ruleName && <p>Rule: {ruleName}</p>}
    {assessment.assets.map((asset) => <div key={asset.id}><p><strong>{asset.fileName}</strong> · {asset.matches === true ? 'Meets requirements' : asset.matches === false ? 'Does not meet requirements' : 'Unverified'}</p><p>Path: {asset.path ?? 'Unknown'}</p><p>File size: {asset.fileSize === null ? 'Unknown' : `${asset.fileSize.toLocaleString()} bytes`} · Dimensions: {asset.width ?? '?'} × {asset.height ?? '?'}</p>
      <ul>{asset.requirements.map((requirement,index) => <li key={index}>{requirement.matches === true ? 'Met' : requirement.matches === false ? 'Not met' : 'Unknown'}: {requirement.description}</li>)}</ul>
    </div>)}
  </div>;
}
