import {
  FilePatchSet,
  FilePatch,
  TabItem,
  FileItem,
} from './src/types';
import {
  isValidFilePatchSet,
  validatePatchSet,
  applyPatchSetAtomically,
} from './src/utils/patchParser';
import { getSkill } from './src/utils/skillRegistry';
import { executeAgentTool } from './src/utils/agentSkillExecutor';

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

async function runPatchSetTests() {
  console.log('====================================================');
  console.log('RAY HARNESS - MULTI-FILE PATCH-SET TEST SUITE');
  console.log('====================================================\n');

  // Test 1: Registry Contract
  console.log('[1/4] Skill Registry & Tool Contract');
  const patchSkill = getSkill('patch_proposer');
  assert(Boolean(patchSkill), 'patch_proposer skill registered');
  const patchSetTool = patchSkill?.tools.find(t => t.id === 'propose_patch_set');
  assert(Boolean(patchSetTool), 'propose_patch_set tool registered');
  assert(patchSetTool?.permissionLevel === 'workspace_write', 'propose_patch_set requires workspace_write');
  assert(patchSetTool?.requiresApproval === true, 'propose_patch_set requires human approval');

  // Test 2: Validation Rules
  console.log('\n[2/4] Patch Set Validation Rules');
  
  const samplePatches: FilePatch[] = [
    {
      type: 'file_patch',
      patchId: 'p1',
      path: 'src/lib.rs',
      originalContent: '// orig lib\n',
      proposedContent: '// new lib\n',
      requiresApproval: true,
      status: 'pending',
    },
    {
      type: 'file_patch',
      patchId: 'p2',
      path: 'src/main.rs',
      originalContent: '// orig main\n',
      proposedContent: '// new main\n',
      requiresApproval: true,
      status: 'pending',
    },
  ];

  const validPatchSet: FilePatchSet = {
    type: 'file_patch_set',
    patchSetId: 'ps_valid',
    description: 'Update lib and main',
    patches: samplePatches,
    createdAt: '12:00 PM',
    status: 'proposed',
    requiresApproval: true,
    correlationId: 'cor_123',
    authorAgent: 'code_executor',
  };

  assert(isValidFilePatchSet(validPatchSet), 'isValidFilePatchSet returns true for valid patch set');

  const currentTabs: TabItem[] = [
    { id: 't1', name: 'lib.rs', path: 'src/lib.rs', language: 'rust', content: '// orig lib\n' },
    { id: 't2', name: 'main.rs', path: 'src/main.rs', language: 'rust', content: '// orig main\n' },
  ];
  const files: FileItem[] = [];

  const valRes1 = validatePatchSet(validPatchSet, currentTabs, files);
  assert(valRes1.valid === true, 'validatePatchSet passes when buffer content matches originalContent');

  // Stale buffer test
  const staleTabs: TabItem[] = [
    { id: 't1', name: 'lib.rs', path: 'src/lib.rs', language: 'rust', content: '// MODIFIED BY USER\n' },
    { id: 't2', name: 'main.rs', path: 'src/main.rs', language: 'rust', content: '// orig main\n' },
  ];
  const valResStale = validatePatchSet(validPatchSet, staleTabs, files);
  assert(valResStale.valid === false, 'validatePatchSet fails if any file buffer is stale');
  assert(valResStale.error?.toLowerCase().includes('stale') === true, 'Validation error mentions stale buffer');

  // Duplicate path test
  const duplicatePatchesSet: FilePatchSet = {
    ...validPatchSet,
    patchSetId: 'ps_dup',
    patches: [
      ...samplePatches,
      {
        type: 'file_patch',
        patchId: 'p3',
        path: 'src/lib.rs',
        originalContent: '// orig lib\n',
        proposedContent: '// conflicting change\n',
        requiresApproval: true,
        status: 'pending',
      },
    ],
  };
  const valResDup = validatePatchSet(duplicatePatchesSet, currentTabs, files);
  assert(valResDup.valid === false, 'validatePatchSet fails when patch set has duplicate paths');
  assert(valResDup.error?.includes('Duplicate target file path') === true, 'Validation error mentions duplicate target path');

  // Test 3: Atomic Application & Rollback
  console.log('\n[3/4] Atomic Application & Rollback');

  // Valid application
  const appRes = applyPatchSetAtomically(validPatchSet, currentTabs, files);
  assert(appRes.success === true, 'applyPatchSetAtomically succeeds for valid set');
  assert(appRes.appliedCount === 2, 'applyPatchSetAtomically applied all 2 file changes');
  const updatedLib = appRes.updatedTabs.find(t => t.path === 'src/lib.rs');
  const updatedMain = appRes.updatedTabs.find(t => t.path === 'src/main.rs');
  assert(updatedLib?.content === '// new lib\n', 'src/lib.rs content atomically updated');
  assert(updatedMain?.content === '// new main\n', 'src/main.rs content atomically updated');

  // Rollback on failure (stale buffer)
  const rollbackRes = applyPatchSetAtomically(validPatchSet, staleTabs, files);
  assert(rollbackRes.success === false, 'applyPatchSetAtomically fails on stale buffer');
  assert(rollbackRes.appliedCount === 0, '0 changes applied on failure (all or nothing)');
  assert(rollbackRes.updatedTabs === staleTabs, 'original tabs returned untouched on failure (no partial state modification)');

  // Test 4: Executor Integration
  console.log('\n[4/4] Agent Skill Executor - propose_patch_set');

  let proposedSetCallbackReceived: FilePatchSet | null = null;
  const execResult = await executeAgentTool(
    {
      skillId: 'patch_proposer',
      toolId: 'propose_patch_set',
      parameters: {
        description: 'Refactor configuration and plan',
        patches: [
          {
            filePath: 'config/config.toml',
            originalContent: 'ui_mode = "plan"',
            proposedContent: 'ui_mode = "agent"',
            explanation: 'Update ui_mode to agent',
          },
          {
            filePath: 'plan.md',
            originalContent: '# Plan',
            proposedContent: '# Plan updated',
            explanation: 'Update plan title',
          },
        ],
      },
      context: {
        agentRole: 'code_executor',
        correlationId: 'cor_exec_1',
      },
    },
    {
      onProposePatchSet: (set) => {
        proposedSetCallbackReceived = set;
      },
    }
  );

  assert(execResult.success === true, 'executeAgentTool propose_patch_set succeeds');
  assert(execResult.requiresApproval === true, 'executeAgentTool requires approval');
  assert(Boolean(execResult.patchSetProposal), 'Result contains patchSetProposal');
  assert(execResult.patchSetProposal?.patches.length === 2, 'patchSetProposal contains 2 patches');
  assert(Boolean(proposedSetCallbackReceived), 'onProposePatchSet callback invoked with patch set');
  const receivedSet = proposedSetCallbackReceived as FilePatchSet | null;
  assert(receivedSet?.patchSetId === execResult.patchSetProposal?.patchSetId, 'Callback received matching patch set ID');

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPatchSetTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
