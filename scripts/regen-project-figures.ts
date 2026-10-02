import {
  buildFallbackDiagramSpecs,
  drawingDescriptionFromAssets,
  persistGeneratedDiagrams
} from '../src/lib/patent-generation/figures';
import {
  getPatentProject,
  getPatentProjectDirectory,
  savePatentArtifact
} from '../src/lib/patent-generation/store';
import type { PatentDiagramSpec } from '../src/lib/patent-generation/types';

async function main() {
  const id = 'cf2c1b93-edad-4eac-b3d3-cf08b508f21d';
  const project = getPatentProject(id);
  if (!project?.disclosure) {
    console.log(JSON.stringify({ ok: false, reason: 'project missing' }));
    return;
  }
  const existing = (project.drawings?.assets || [])
    .map((asset) => asset.diagram)
    .filter((item): item is PatentDiagramSpec => Boolean(item));
  const specs = existing.length >= 3
    ? existing
    : buildFallbackDiagramSpecs(project.disclosure, project.strategy);
  const assets = await persistGeneratedDiagrams({
    projectDir: getPatentProjectDirectory(id),
    specs
  });
  savePatentArtifact(id, 'drawings', {
    assets,
    generatedFromSuggestions: true,
    notes: ['已按更高分辨率与正交布局重新生成附图']
  });
  if (project.draft) {
    savePatentArtifact(id, 'draft', {
      ...project.draft,
      drawings: assets,
      drawingDescription: drawingDescriptionFromAssets(assets)
    }, project.draft.claims);
  }
  console.log(JSON.stringify({
    ok: true,
    figures: assets.map((asset) => ({
      n: asset.figureNumber,
      w: asset.widthPx,
      h: asset.heightPx,
      file: asset.fileName
    }))
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
