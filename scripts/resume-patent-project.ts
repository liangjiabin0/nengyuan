import { getPatentProject, setPatentProgress } from '../src/lib/patent-generation/store';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';

async function main() {
  const id = process.argv[2] || 'ffd43540-26d6-42dc-add0-d4c72eafaa32';
  setPatentProgress(id, { status: 'draft', stage: 'prior_art', error: undefined });
  const before = getPatentProject(id);
  console.log('resume', before?.id, before?.status, 'priorArt=', Boolean(before?.priorArt));

  const project = await runPatentPipeline(id, (event) => {
    if (event.type === 'status') console.log(`  [${event.progress}%] ${event.stage}: ${event.detail}`);
    else if (event.type === 'artifact') console.log(`  artifact=${event.kind} status=${event.project.status}`);
    else if (event.type === 'error') console.error('  ERROR', event.error);
    else if (event.type === 'done') console.log(`  done status=${event.project.status} stage=${event.project.currentStage}`);
  });

  const finalProject = getPatentProject(project.id)!;
  console.log(JSON.stringify({
    id: finalProject.id,
    status: finalProject.status,
    stage: finalProject.currentStage,
    qualityScore: finalProject.qualityScore,
    hasDisclosure: Boolean(finalProject.disclosure),
    hasStrategy: Boolean(finalProject.strategy),
    hasDraft: Boolean(finalProject.draft),
    hasDrawings: Boolean(finalProject.drawings?.assets?.length),
    blockers: finalProject.blockers.filter((b) => !b.resolved).map((b) => b.question.slice(0, 80)),
    error: finalProject.error || null
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
