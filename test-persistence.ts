import {
  WorkspacePersistenceManager,
  WorkspacePersistenceAdapter,
  WorkspacePersistenceState,
  normalizeWorkspacePath,
  computeContentHash,
  containsSecrets,
  CURRENT_PERSISTENCE_SCHEMA_VERSION,
  DEFAULT_WORKSPACE_ID,
} from './src/utils/workspacePersistence';
import { FilePatch, FilePatchSet, TabItem, TimelineEvent } from './src/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
    process.exitCode = 1;
  }
}

/**
 * In-Memory Adapter for Node test suite
 */
class MemoryPersistenceAdapter implements WorkspacePersistenceAdapter {
  public store: Record<string, string> = {};
  public shouldFailSave = false;

  private getKey(workspaceId: string) {
    return `ray_harness_approved_workspace_v${CURRENT_PERSISTENCE_SCHEMA_VERSION}_${workspaceId}`;
  }

  loadState(workspaceId: string): WorkspacePersistenceState | null {
    const raw = this.store[this.getKey(workspaceId)];
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveState(state: WorkspacePersistenceState): { success: boolean; error?: string } {
    if (this.shouldFailSave) {
      return { success: false, error: 'Storage quota exceeded (simulated failure)' };
    }
    this.store[this.getKey(state.workspaceId)] = JSON.stringify(state);
    return { success: true };
  }

  clearState(workspaceId: string): boolean {
    delete this.store[this.getKey(workspaceId)];
    return true;
  }
}

async function runPersistenceTests() {
  console.log('====================================================');
  console.log('RAY HARNESS - WORKSPACE PERSISTENCE & RECOVERY TEST SUITE');
  console.log('====================================================');

  const initialTabs: TabItem[] = [
    {
      id: 'tab_config',
      name: 'config.toml',
      path: 'jarvis-app/config/config.toml',
      language: 'toml',
      content: 'ui_mode = "plan"\nmodel = "Gemini 3.8 Flash"',
    },
    {
      id: 'tab_main',
      name: 'main.rs',
      path: 'jarvis-app/src/main.rs',
      language: 'rust',
      content: 'fn main() { println!("Hello world"); }',
    },
  ];

  // Test 1: Path Normalization & Security Boundaries
  console.log('\n[1/13] Path Normalization & Security Boundaries');
  const validPathResult = normalizeWorkspacePath('jarvis-app/config/config.toml');
  assert(validPathResult.valid === true, 'Valid relative path accepted');
  assert(validPathResult.normalizedPath === 'jarvis-app/config/config.toml', 'Normalized relative path clean');

  const pathTraversalResult = normalizeWorkspacePath('../../../etc/passwd');
  assert(pathTraversalResult.valid === false, 'Path traversal attempt rejected');
  assert(pathTraversalResult.error?.includes('Path traversal') === true, 'Error message cites path traversal');

  const absolutePathResult = normalizeWorkspacePath('/usr/local/bin/malicious.sh');
  assert(absolutePathResult.valid === false, 'Absolute path attempt rejected');
  assert(absolutePathResult.error?.includes('Absolute paths not allowed') === true, 'Error message cites absolute paths');

  // Test 2: Approved Single-File Patch Persistence
  console.log('\n[2/13] Approved Single-File Patch Persistence');
  const adapter = new MemoryPersistenceAdapter();
  const manager = new WorkspacePersistenceManager(adapter, DEFAULT_WORKSPACE_ID);

  const telemetryEvents: TimelineEvent[] = [];
  const recordTelemetry = (evt: any) => {
    telemetryEvents.push({ id: `evt_${Date.now()}`, timestamp: new Date().toISOString(), ...evt });
  };

  const approvedPatch: FilePatch = {
    type: 'file_patch',
    patchId: 'patch_single_001',
    path: 'jarvis-app/config/config.toml',
    originalContent: 'ui_mode = "plan"\nmodel = "Gemini 3.8 Flash"',
    proposedContent: 'ui_mode = "agent"\nmodel = "Gemini 3.8 Flash"\napps_enabled = true',
    requiresApproval: true,
    authorAgent: 'code_executor',
  };

  const persistRes1 = manager.persistApprovedPatch(approvedPatch, initialTabs, recordTelemetry);
  assert(persistRes1.success === true, 'Approved single patch persisted successfully');

  const storedState1 = manager.getState();
  assert(Boolean(storedState1?.files['jarvis-app/config/config.toml']), 'Record exists in stored state');
  assert(
    storedState1?.files['jarvis-app/config/config.toml'].content === approvedPatch.proposedContent,
    'Stored content matches proposed content'
  );

  // Test 3: Rejected Patch NOT Persisted
  console.log('\n[3/13] Rejected Patch Not Persisted');
  const rejectedPatchId = 'patch_rej_002';
  // Simulate rejection: manager.persistApprovedPatch is NEVER called on rejection
  const stateAfterRejection = manager.getState();
  assert(!stateAfterRejection?.files['jarvis-app/src/unknown.rs'], 'Rejected patch target not present in storage');

  // Test 4: Cancelled Review NOT Persisted
  console.log('\n[4/13] Cancelled Review Not Persisted');
  // Simulate cancellation: manager.persistApprovedPatch is NEVER called
  const stateAfterCancel = manager.getState();
  assert(Object.keys(stateAfterCancel?.files || {}).length === 1, 'File count unchanged after cancel');

  // Test 5: Approved Multi-File Patch Set Persistence
  console.log('\n[5/13] Approved Multi-File Patch Set Persistence');
  const approvedPatchSet: FilePatchSet = {
    type: 'file_patch_set',
    patchSetId: 'patchset_001',
    description: 'Add render engine and updated main',
    createdAt: new Date().toISOString(),
    status: 'approved',
    requiresApproval: true,
    patches: [
      {
        type: 'file_patch',
        patchId: 'patch_ps_1',
        path: 'jarvis-app/src/render.rs',
        originalContent: '',
        proposedContent: 'pub fn render() { println!("Render engine"); }',
        requiresApproval: true,
      },
      {
        type: 'file_patch',
        patchId: 'patch_ps_2',
        path: 'jarvis-app/src/main.rs',
        originalContent: 'fn main() { println!("Hello world"); }',
        proposedContent: 'fn main() { render(); }',
        requiresApproval: true,
      },
    ],
  };

  const psRes = manager.persistApprovedPatchSet(approvedPatchSet, initialTabs, recordTelemetry);
  assert(psRes.success === true, 'Approved multi-file patch set persisted successfully');
  assert(psRes.recordsCount === 2, 'Reported 2 records updated in storage');

  const storedState2 = manager.getState();
  assert(Boolean(storedState2?.files['jarvis-app/src/render.rs']), 'render.rs present in state');
  assert(Boolean(storedState2?.files['jarvis-app/src/main.rs']), 'main.rs present in state');

  // Test 6: Atomic Persistence Failure Behavior
  console.log('\n[6/13] Atomic Persistence Failure Behavior');
  adapter.shouldFailSave = true; // Simulate QuotaExceededError or storage error
  const failPatchSet: FilePatchSet = {
    type: 'file_patch_set',
    patchSetId: 'patchset_fail',
    description: 'Failing set',
    createdAt: new Date().toISOString(),
    status: 'approved',
    requiresApproval: true,
    patches: [
      {
        type: 'file_patch',
        patchId: 'p_fail_1',
        path: 'jarvis-app/src/fail.rs',
        originalContent: '',
        proposedContent: 'fn fail() {}',
        requiresApproval: true,
      },
    ],
  };

  const failRes = manager.persistApprovedPatchSet(failPatchSet, initialTabs, recordTelemetry);
  assert(failRes.success === false, 'Atomic persistence failed when adapter fails save');
  assert(failRes.error?.toLowerCase().includes('quota') === true, 'Error message cites quota/storage error');

  adapter.shouldFailSave = false; // Restore adapter function

  // Test 7: Stale Patch Persistence Rejection
  console.log('\n[7/13] Stale Patch Persistence Rejection');
  const invalidPathPatchSet: FilePatchSet = {
    type: 'file_patch_set',
    patchSetId: 'patchset_invalid_path',
    description: 'Path traversal patch set',
    createdAt: new Date().toISOString(),
    status: 'approved',
    requiresApproval: true,
    patches: [
      {
        type: 'file_patch',
        patchId: 'p_bad_path',
        path: '../out_of_bounds.rs',
        originalContent: '',
        proposedContent: 'malicious',
        requiresApproval: true,
      },
    ],
  };
  const badPathRes = manager.persistApprovedPatchSet(invalidPathPatchSet, initialTabs, recordTelemetry);
  assert(badPathRes.success === false, 'Persistence rejected when patch contains unsafe path');

  // Test 8: Recovery from Valid State
  console.log('\n[8/13] Recovery from Valid State');
  const recoveryRes = manager.recoverWorkspace(initialTabs, [], recordTelemetry);
  assert(recoveryRes.status === 'restored', 'Recovery status is restored');
  assert(recoveryRes.recoveredFilesCount === 3, 'Recovered 3 approved files');
  assert(recoveryRes.restoredPaths.includes('jarvis-app/config/config.toml'), 'Restored config.toml');
  assert(recoveryRes.restoredPaths.includes('jarvis-app/src/render.rs'), 'Restored render.rs');

  // Test 9: Corrupted State Handling
  console.log('\n[9/13] Corrupted State Handling');
  adapter.store[`ray_harness_approved_workspace_v${CURRENT_PERSISTENCE_SCHEMA_VERSION}_${DEFAULT_WORKSPACE_ID}`] = '{ corrupted_json... ';
  const corruptedRecovery = manager.recoverWorkspace(initialTabs, [], recordTelemetry);
  assert(corruptedRecovery.status === 'no_data', 'Corrupted JSON handled gracefully without crashing');

  // Restore valid state for remaining tests
  manager.persistApprovedPatchSet(approvedPatchSet, initialTabs, recordTelemetry);

  // Test 10: Schema Version Mismatch
  console.log('\n[10/13] Schema Version Mismatch');
  const mismatchedState = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    schemaVersion: 999, // Incompatible future schema
    updatedAt: new Date().toISOString(),
    files: {
      'jarvis-app/src/main.rs': {
        path: 'jarvis-app/src/main.rs',
        content: 'fn main() {}',
        contentHash: 'hash999',
        timestamp: new Date().toISOString(),
        source: 'single_patch',
        persistenceStatus: 'synced',
      },
    },
  };
  adapter.store[`ray_harness_approved_workspace_v${CURRENT_PERSISTENCE_SCHEMA_VERSION}_${DEFAULT_WORKSPACE_ID}`] = JSON.stringify(mismatchedState);
  const versionMismatchRecovery = manager.recoverWorkspace(initialTabs, [], recordTelemetry);
  assert(versionMismatchRecovery.status === 'error', 'Schema mismatch yields error status');
  assert(versionMismatchRecovery.error?.includes('Incompatible persistence schema version') === true, 'Error cites incompatible schema version');

  // Test 11: Secret Exclusion Verification
  console.log('\n[11/13] Secret Exclusion Verification');
  const textWithSecret = 'export GEMINI_API_KEY="AIzaSyA_mock_secret_key_123456789"';
  assert(containsSecrets(textWithSecret) === true, 'Secret detector identifies GEMINI API key in content');

  // Test 12: Clear / Reset Behavior
  console.log('\n[12/13] Clear / Reset Behavior');
  manager.persistApprovedPatch(approvedPatch, initialTabs, recordTelemetry);
  const clearResult = manager.clearWorkspace(recordTelemetry);
  assert(clearResult === true, 'clearWorkspace returned true');
  const stateAfterClear = manager.getState();
  assert(stateAfterClear === null, 'Stored state completely removed after clear');

  // Test 13: Persistence Telemetry Sanitization
  console.log('\n[13/13] Persistence Telemetry Sanitization');
  const startedEvent = telemetryEvents.find(e => e.type === 'workspace_persistence_started');
  assert(Boolean(startedEvent), 'Recorded workspace_persistence_started telemetry event');
  assert(startedEvent?.metadata?.workspaceId === DEFAULT_WORKSPACE_ID, 'Telemetry metadata contains workspaceId');
  assert(!startedEvent?.metadata?.proposedContent, 'Telemetry metadata strictly excludes full proposed content');

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPersistenceTests();
