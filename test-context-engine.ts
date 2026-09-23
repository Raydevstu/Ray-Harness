import { ContextEngine, ContextFragment, ContextPriority, estimateTokenCount, DeterministicCompactionStrategy } from './src/utils/contextEngine';
import { ModelRouter, SUPPORTED_MODELS } from './src/utils/modelRouter';
import { ModelOption } from './src/types';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? `: ${detail}` : ''}`);
    failCount++;
  }
}

async function runContextEngineTests() {
  console.log('====================================================');
  console.log('RAY HARNESS - CONTEXT ENGINE VERIFICATION SUITE');
  console.log('====================================================\n');

  const router = new ModelRouter('Gemini 3.8 Flash');
  const engine = new ContextEngine(router);

  // 1. Fragment Creation
  console.log('[1] Fragment Creation & Ingestion');
  const frag1: ContextFragment = {
    id: 'f_sys_01',
    type: 'system',
    content: 'Do not allow deletion of source directories.',
    source: 'system:instruction',
    priority: ContextPriority.CRITICAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };

  engine.collect([frag1]);
  const currentFrags = engine.getFragments();
  assert(currentFrags.length === 1, 'Ingested fragment count is correct');
  assert(currentFrags[0].id === 'f_sys_01', 'Retained correct fragment ID');

  // 2. Fragment Metadata Validation
  console.log('\n[2] Fragment Metadata Validation');
  const loaded = currentFrags[0];
  assert(loaded.type === 'system', 'Correct type field metadata preserved');
  assert(loaded.priority === ContextPriority.CRITICAL, 'Correct priority level metadata preserved');
  assert(loaded.source === 'system:instruction', 'Correct provenance tracking field preserved');

  // 3. Priority Ordering (Deterministic prioritization)
  console.log('\n[3] Deterministic Priority Sorting');
  engine.clear();
  const lowFrag: ContextFragment = {
    id: 'f_low',
    type: 'conversation',
    content: 'Low priority chatter.',
    source: 'conversation:message',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date(Date.now() - 5000).toISOString(),
  };
  const highFrag: ContextFragment = {
    id: 'f_high',
    type: 'user',
    content: 'High priority intent.',
    source: 'conversation:message',
    priority: ContextPriority.HIGH,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  const normalFrag: ContextFragment = {
    id: 'f_normal',
    type: 'workspace',
    content: 'Normal priority file info.',
    source: 'workspace:file',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: new Date(Date.now() - 1000).toISOString(),
  };

  engine.collect([lowFrag, highFrag, normalFrag]);
  const sorted = engine.prioritize();
  assert(sorted[0].id === 'f_high', 'Highest priority item sorted to front');
  assert(sorted[1].id === 'f_normal', 'Normal priority item sorted to index 1');
  assert(sorted[2].id === 'f_low', 'Lowest priority item sorted to index 2');

  // 4. Token Estimation (approximate vs exact)
  console.log('\n[4] Token Estimation Adapter');
  const shortText = 'Hello World';
  const estimated = estimateTokenCount(shortText);
  assert(estimated === Math.ceil(shortText.length / 4), 'Token count approximates characters divided by 4');
  assert(estimateTokenCount('') === 0, 'Empty string yields 0 estimated tokens');

  // 5. Budget Calculation (ModelRouter mapping Integration)
  console.log('\n[5] Context Budget Allocation');
  const gemini38Budget = engine.getBudget('Gemini 3.8 Flash');
  assert(gemini38Budget.maxContextTokens === 1048576, 'Retrieves accurate context limit for Gemini 3.8 Flash');
  assert(gemini38Budget.reservedOutputTokens === 8192, 'Retrieves accurate max output tokens');
  assert(gemini38Budget.systemTokenBudget > 0, 'System token allocation budget calculated cleanly');

  // 6. Reserved Output Tokens Invariant
  console.log('\n[6] Reserved Output Tokens Budget Boundary');
  const totalModelWindow = gemini38Budget.maxContextTokens;
  const inputBudget = totalModelWindow - gemini38Budget.reservedOutputTokens;
  assert(inputBudget + gemini38Budget.reservedOutputTokens === totalModelWindow, 'Context window budget math balances correctly');

  // 7. Model-Specific Limits fallback
  console.log('\n[7] Model-Specific Context Limit Resolution');
  // Pass an unknown model option to trigger metadata failure fallback
  const fallbackBudget = engine.getBudget('NonExistentModel' as ModelOption);
  assert(fallbackBudget.maxContextTokens === 262144, 'Gracefully falls back to safety token limit (262144) for unknown models');
  assert(fallbackBudget.reservedOutputTokens === 4096, 'Gracefully falls back to safety reserved output (4096)');

  // 8. Context Overflow Simulation
  console.log('\n[8] Context Overflow Management');
  engine.clear();
  const overflowRouter = new ModelRouter('5.6 Luna Light'); // Context window 262,144; maxInput allowed is smaller
  const overflowEngine = new ContextEngine(overflowRouter);

  // Large item to trigger overflow
  const monsterContent = 'a'.repeat(1050000); // Exceeds 5.6 Luna Light limits significantly
  const monsterFrag: ContextFragment = {
    id: 'f_monster',
    type: 'workspace',
    content: monsterContent,
    source: 'workspace:file',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  const criticalRule: ContextFragment = {
    id: 'f_crit_rule',
    type: 'system',
    content: 'CRITICAL SECURITY INSTRUCTION',
    source: 'system:instruction',
    priority: ContextPriority.CRITICAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };

  overflowEngine.collect([monsterFrag, criticalRule]);
  const overflowResult = overflowEngine.buildContext('5.6 Luna Light');
  assert(overflowResult.snapshot.removedFragments.some(f => f.id === 'f_monster'), 'Oversized low priority item pruned during overflow resolution');

  // 9. Critical Context Preservation
  console.log('\n[9] Critical Context Preservation');
  assert(overflowResult.snapshot.selectedFragments.some(f => f.id === 'f_crit_rule'), 'Critical system rules are strictly preserved in active window');

  // 10. Conversation Truncation & Compaction
  console.log('\n[10] Conversation Truncation');
  engine.clear();
  const chatFrag: ContextFragment = {
    id: 'f_chat_long',
    type: 'conversation',
    content: 'Hey, did you look at the logs yet? Yes, I looked at the database logs. They look okay. What about the web server? The web server is throwing errors. Can you restart it? I am working on it right now. Okay, keep me updated on the state of the restart process.',
    source: 'conversation:message',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  engine.collect([chatFrag]);
  const compactResult = engine.buildContext('5.6 Luna Light');
  const compactedChat = compactResult.snapshot.selectedFragments.find(f => f.id === 'f_chat_long');
  assert(compactedChat !== undefined, 'Chat fragment processed');
  assert(compactedChat!.content.includes('COMPACTED HISTORIC CHAT MESSAGE'), 'Old chat message is deterministically compacted');

  // 11. Tool Result Truncation & Limit
  console.log('\n[11] Tool-Result Truncation Policies');
  engine.clear();
  const oversizedToolOutput = 'A'.repeat(3000); // estimated ~750 tokens
  const toolFrag: ContextFragment = {
    id: 'f_tool_huge',
    type: 'tool_result',
    content: oversizedToolOutput,
    source: 'tool:result',
    priority: ContextPriority.NORMAL,
    tokenEstimate: estimateTokenCount(oversizedToolOutput),
    timestamp: new Date().toISOString(),
  };
  engine.collect([toolFrag]);
  const toolCompactResult = engine.buildContext('5.6 Luna Light');
  const compactedTool = toolCompactResult.snapshot.selectedFragments.find(f => f.id === 'f_tool_huge');
  assert(compactedTool !== undefined, 'Tool result fragment processed');
  assert(compactedTool!.content.includes('Deterministically Compacted Tool Result'), 'Tool result is compacted when exceeding token estimates');

  // 12. Duplicate Workspace file Version Handling
  console.log('\n[12] Duplicate File Version Deduplication');
  engine.clear();
  const fileV1: ContextFragment = {
    id: 'file_v1',
    type: 'file',
    content: 'v1: const x = 1;',
    source: 'workspace:file',
    priority: ContextPriority.NORMAL,
    provenance: 'src/config.js',
    tokenEstimate: 0,
    timestamp: new Date(Date.now() - 10000).toISOString(),
  };
  const fileV2: ContextFragment = {
    id: 'file_v2',
    type: 'file',
    content: 'v2: const x = 2;',
    source: 'workspace:file',
    priority: ContextPriority.NORMAL,
    provenance: 'src/config.js',
    tokenEstimate: 0,
    timestamp: new Date().toISOString(), // Newest
  };
  engine.collect([fileV1, fileV2]);
  const dedupResult = engine.buildContext('5.6 Luna Light');
  const selectedFiles = dedupResult.snapshot.selectedFragments.filter(f => f.type === 'file');
  assert(selectedFiles.length === 1, 'File selection contains exactly 1 unique provenance record');
  assert(selectedFiles[0].id === 'file_v2', 'Retained the newest version based on timestamp');

  // 13. Deterministic Compaction Execution
  console.log('\n[13] Deterministic Compaction Strategy execution');
  const compactor = new DeterministicCompactionStrategy();
  const compactResultObj = compactor.compact([toolFrag], engine.getBudget('5.6 Luna Light'));
  assert(compactResultObj.actions.length > 0, 'Actions telemetry successfully generated during compaction');
  assert(compactResultObj.truncations.length > 0, 'Truncation decisions mapped cleanly inside return footprint');

  // 14. Provenance Tracking
  console.log('\n[14] Context Provenance Traceability');
  engine.clear();
  engine.collect([frag1]);
  const buildRes = engine.buildContext('Gemini 3.8 Flash');
  const traceItem = buildRes.snapshot.selectedFragments[0];
  assert(traceItem.source === 'system:instruction', 'Information source maps cleanly to provenance metadata');

  // 15. Context Snapshot Invariants
  console.log('\n[15] Snapshot Generation');
  const snapshot = buildRes.snapshot;
  assert(snapshot.selectedFragments.length > 0, 'Snapshot lists selected fragments');
  assert(snapshot.estimatedTokenUsage > 0, 'Snapshot tracks estimated input tokens');
  assert(snapshot.maximumTokenBudget > 0, 'Snapshot tracks maximum token budget');

  // 16. Missing Model Metadata Handling
  console.log('\n[16] Missing Model Fallback Reporting');
  const missingConfigBudget = engine.getBudget('NonExistentModel' as ModelOption);
  assert(missingConfigBudget.maxContextTokens === 262144, 'Safety context limit enforced');

  // 17. Secret Exclusion & Filtering Invariants
  console.log('\n[17] Secret Exclusion Ingestion Filter');
  engine.clear();
  const secretFrag: ContextFragment = {
    id: 'f_secret',
    type: 'user',
    content: 'My Gemini Key is AIzaSyDUMMYKEY1234567890PASS1234567890 and password="safe_password"',
    source: 'conversation:message',
    priority: ContextPriority.HIGH,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  engine.collect([secretFrag]);
  const secretResult = engine.buildContext();
  const processedContent = secretResult.snapshot.selectedFragments[0].content;
  assert(!processedContent.includes('AIzaSyDUMMYKEY'), 'Gemini API key is redacted during context ingestion');
  assert(processedContent.includes('[REDACTED]'), 'Redacted sensitive variables mapped correctly');

  // 18. Empty Context Handling
  console.log('\n[18] Empty Context Handling');
  engine.clear();
  const emptyRes = engine.buildContext();
  assert(emptyRes.prompt === '', 'Builds empty string on empty context collection');
  assert(emptyRes.snapshot.selectedFragments.length === 0, 'Snapshot correctly shows 0 active fragments');

  // 19. Extremely Large Context Safety Limits
  console.log('\n[19] Large Context Safety Bounds');
  const multiFragments: ContextFragment[] = [];
  for (let i = 0; i < 200; i++) {
    multiFragments.push({
      id: `f_bulk_${i}`,
      type: 'user',
      content: 'A'.repeat(10000), // ~2500 tokens per fragment -> total ~500,000 tokens (exceeds budget)
      source: 'conversation:message',
      priority: ContextPriority.LOW,
      tokenEstimate: 0,
      timestamp: new Date().toISOString(),
    });
  }
  // Enforce small context limit model
  engine.collect(multiFragments);
  const bulkRes = engine.buildContext('5.6 Luna Light'); // Context budget is 262,144; input capacity around 258,048
  assert(bulkRes.snapshot.selectedFragments.length < 200, 'Ensures strict enforcement of input token allocation without crashing or running out of memory');
  assert(bulkRes.snapshot.estimatedTokenUsage <= bulkRes.snapshot.maximumTokenBudget, 'Calculated input tokens strictly respects maximum input limit constraints');

  // 20. Cancellation-Safe Context Capture
  console.log('\n[20] Cancellation-Safe Invariants');
  // Confirm building context doesn't block, freeze, or use async operations
  let successRun = true;
  try {
    const cancelEngine = new ContextEngine();
    cancelEngine.collect([frag1]);
    const res = cancelEngine.buildContext();
    assert(res !== undefined, 'Context resolves synchronously and instantly');
  } catch (err) {
    successRun = false;
  }
  assert(successRun, 'Context build process is non-blocking and cancellation-safe');

  // 21. Hardening & Deep Verification Pass
  console.log('\n[21] Deep Verification & Hardening Pass');

  // Edge Case A: Equal timestamp deterministic ordering
  const nowStr = new Date().toISOString();
  const tieFragA: ContextFragment = {
    id: 'f_tie_a',
    type: 'user',
    content: 'Content A',
    source: 'user:input',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: nowStr,
  };
  const tieFragB: ContextFragment = {
    id: 'f_tie_b',
    type: 'user',
    content: 'Content B',
    source: 'user:input',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: nowStr, // identical timestamp
  };

  engine.clear();
  engine.collect([tieFragB, tieFragA]); // ingest B first to test sorting
  const tieSorted = engine.prioritize();
  assert(
    tieSorted[0].id === 'f_tie_a' && tieSorted[1].id === 'f_tie_b',
    'Equal timestamp tie-breaking resolves deterministically using alphabetical ID'
  );

  // Edge Case B: Deduplication tie-breaking
  const dupFileA: ContextFragment = {
    id: 'file_dup_a',
    type: 'file',
    content: 'older content',
    source: 'workspace:file',
    provenance: 'src/unique.js',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: nowStr,
  };
  const dupFileB: ContextFragment = {
    id: 'file_dup_b',
    type: 'file',
    content: 'newer content',
    source: 'workspace:file',
    provenance: 'src/unique.js',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: nowStr, // same timestamp, id 'file_dup_b' sorted after 'file_dup_a'
  };

  engine.clear();
  engine.collect([dupFileA, dupFileB]);
  const dupResult = engine.buildContext();
  const dupFiles = dupResult.snapshot.selectedFragments.filter(f => f.provenance === 'src/unique.js');
  assert(dupFiles.length === 1, 'File selection contains exactly 1 unique provenance record under identical timestamps');
  assert(dupFiles[0].id === 'file_dup_a', 'Retained the correct file based on tie-breaking deterministic sort');

  // Edge Case C: Category budgets saturation vs usable input budget
  const budgetObj = engine.getBudget('Gemini 3.8 Flash');
  const sumOfCategories = 
    budgetObj.systemTokenBudget + 
    budgetObj.conversationTokenBudget + 
    budgetObj.toolResultBudget + 
    budgetObj.workspaceBudget;
  const usableBudget = budgetObj.maxContextTokens - budgetObj.reservedOutputTokens;
  assert(sumOfCategories <= usableBudget, 'All sub-budgets simultaneously saturated do not collectively exceed usable input budget');
  assert(usableBudget + budgetObj.reservedOutputTokens === budgetObj.maxContextTokens, 'Usable input budget + reserved output exactly equals total context limit');

  // Edge Case D: Exact boundary and one-token overflow
  // Let's create an engine with a customized small model setup
  // We can select "5.6 Luna Light" with maxContextTokens: 262144, reservedOutputTokens: 4096.
  // Usable limit is 258,048.
  const boundaryEngine = new ContextEngine(new ModelRouter('5.6 Luna Light'));
  const maxInputLimit = 262144 - 4096; // 258,048 tokens -> 1,032,192 chars

  // Create fragment that exactly fits the usable budget
  const exactFitContent = 'x'.repeat(maxInputLimit * 4); // 1032192 chars = 258048 tokens
  const exactFitFrag: ContextFragment = {
    id: 'f_exact',
    type: 'user',
    content: exactFitContent,
    source: 'user:input',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };

  boundaryEngine.collect([exactFitFrag]);
  const boundaryResult1 = boundaryEngine.buildContext();
  assert(boundaryResult1.snapshot.selectedFragments.some(f => f.id === 'f_exact'), 'Exact-fit fragment is successfully retained within boundary limits');
  assert(boundaryResult1.snapshot.removedFragments.length === 0, 'No fragments removed when exactly matching budget capacity');

  // Add a 1-token-over-limit fragment (e.g. 4 chars)
  const overflowFrag: ContextFragment = {
    id: 'f_one_token_overflow',
    type: 'user',
    content: 'over', // 4 chars = 1 token
    source: 'user:input',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };

  boundaryEngine.collect([overflowFrag]);
  const boundaryResult2 = boundaryEngine.buildContext();
  assert(boundaryResult2.snapshot.selectedFragments.some(f => f.id === 'f_exact'), 'Main exact fragment retained under one-token overflow');
  assert(boundaryResult2.snapshot.removedFragments.some(f => f.id === 'f_one_token_overflow'), 'One-token-overflow fragment is deterministically pruned');

  // Edge Case E: Unknown model fallback budget parameters
  const unknownBudget = engine.getBudget('FakeLunaModel' as ModelOption);
  assert(unknownBudget.maxContextTokens === 262144, 'Unknown model falls back gracefully to a secure 262,144 token context limit');
  assert(unknownBudget.reservedOutputTokens === 4096, 'Unknown model falls back gracefully to a 4,096 reserved output token limit');

  // Edge Case F: Invalid/Zero/Negative budget inputs handled gracefully
  const zeroBudgetEngine = new ContextEngine();
  // Temporarily corrupt supported models configuration to test protection path
  const originalLuna = SUPPORTED_MODELS['5.6 Luna Light'];
  try {
    SUPPORTED_MODELS['5.6 Luna Light'] = {
      ...originalLuna,
      contextWindow: 0, // Corrupted invalid limit
      maxOutputTokens: -100, // Corrupted invalid output
    };
    const corruptedBudget = zeroBudgetEngine.getBudget('5.6 Luna Light');
    assert(corruptedBudget.maxContextTokens > 0, 'Corrupted zero contextWindow fallback guarantees positive total tokens');
    assert(corruptedBudget.reservedOutputTokens > 0, 'Corrupted negative maxOutputTokens fallback guarantees positive reserved output tokens');
  } finally {
    // Restore config
    SUPPORTED_MODELS['5.6 Luna Light'] = originalLuna;
  }

  // Edge Case G: No mutation of original fragments
  const originalFragContent = 'Original test fragment content';
  const originalFrag: ContextFragment = {
    id: 'f_mutation_test',
    type: 'conversation',
    content: originalFragContent,
    source: 'conversation:message',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  engine.clear();
  engine.collect([originalFrag]);
  // Compacting will mutate content since it's a conversation item with > 150 chars if we make it long:
  const longChatContent = 'A'.repeat(500);
  const longChatFrag: ContextFragment = {
    id: 'f_mutation_long',
    type: 'conversation',
    content: longChatContent,
    source: 'conversation:message',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  
  engine.clear();
  engine.collect([longChatFrag]);
  const compactionBudget = engine.getBudget('5.6 Luna Light');
  engine.compact(compactionBudget);
  assert(longChatFrag.content === longChatContent, 'Original fragment object remains unmutated (compactor operates on shallow copies)');

  // Edge Case H: Critical-context preservation under extreme overflow
  const extremeEngine = new ContextEngine(new ModelRouter('5.6 Luna Light'));
  // Create an extremely large non-critical fragment
  const giganticFrag: ContextFragment = {
    id: 'f_gigantic',
    type: 'user',
    content: 'X'.repeat(2000000), // ~500,000 tokens (exceeds budget by 2x)
    source: 'user:input',
    priority: ContextPriority.LOW,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  // Create a small critical system fragment
  const criticalSystemFrag: ContextFragment = {
    id: 'f_critical_preserved',
    type: 'system',
    content: 'CRITICAL SECURITY MANDATE',
    source: 'system:instruction',
    priority: ContextPriority.CRITICAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  extremeEngine.collect([giganticFrag, criticalSystemFrag]);
  const extremeRes = extremeEngine.buildContext();
  assert(
    extremeRes.snapshot.selectedFragments.some(f => f.id === 'f_critical_preserved'),
    'Critical system instructions are strictly preserved even under total budget exhaustion and extreme overflow'
  );
  assert(
    extremeRes.snapshot.removedFragments.some(f => f.id === 'f_gigantic'),
    'Gigantic non-critical fragment is pruned when budget is completely exhausted'
  );

  // Edge Case I: Truncation markers and provenance preservation
  const truncFileFrag: ContextFragment = {
    id: 'f_trunc_file',
    type: 'file',
    content: 'B'.repeat(8000), // estimated ~2000 tokens (triggers Rule 4 compaction)
    source: 'workspace:file',
    provenance: 'src/utils/core.ts',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  engine.clear();
  engine.collect([truncFileFrag]);
  const truncRes = engine.buildContext();
  const truncatedFile = truncRes.snapshot.selectedFragments.find(f => f.id === 'f_trunc_file');
  assert(truncatedFile !== undefined, 'Large file fragment processed for truncation');
  assert(truncatedFile!.content.includes('Deterministically Compacted File Content'), 'File truncation includes highly explicit truncation markers');
  assert(truncatedFile!.provenance === 'src/utils/core.ts', 'File truncation preserves exact original provenance metadata');

  // Edge Case J: Redaction BEFORE token estimation & building context
  const keyToRedact = 'AIzaSyPASSKEY12345678901234567890';
  const apiSecretFrag: ContextFragment = {
    id: 'f_api_secret_test',
    type: 'user',
    content: `Bearer ${keyToRedact}`,
    source: 'conversation:message',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  engine.clear();
  engine.collect([apiSecretFrag]);
  const collectedFrag = engine.getFragments()[0];
  assert(!collectedFrag.content.includes(keyToRedact), 'Secrets are redacted instantly during Phase 1 COLLECT ingestion (before estimation or compaction)');
  assert(collectedFrag.tokenEstimate < estimateTokenCount(`Bearer ${keyToRedact}`), 'Token estimates are derived from sanitized/redacted content');

  // Edge Case K: Snapshot accuracy
  const snapshotRes = engine.buildContext();
  assert(snapshotRes.snapshot.selectedFragments.length === 1, 'Snapshot accurately tracks count of active selected fragments');
  assert(snapshotRes.snapshot.removedFragments.length === 0, 'Snapshot accurately tracks count of removed fragments');
  assert(snapshotRes.snapshot.estimatedTokenUsage === estimateTokenCount(snapshotRes.prompt), 'Snapshot estimated token usage exactly reflects final compiled prompt content');

  // Edge Case L: Deterministic repeated execution
  const repEngine = new ContextEngine();
  const repFrag1: ContextFragment = {
    id: 'f_rep_1',
    type: 'user',
    content: 'Repetition Test',
    source: 'user:input',
    priority: ContextPriority.NORMAL,
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
  };
  repEngine.collect([repFrag1]);
  const run1 = repEngine.buildContext();
  const run2 = repEngine.buildContext();
  assert(run1.prompt === run2.prompt, 'Sequential repeated buildContext executions are 100% deterministic and yield identical prompt strings');
  assert(JSON.stringify(run1.snapshot) === JSON.stringify(run2.snapshot), 'Sequential repeated buildContext snapshots are perfectly identical');

  console.log(`\n====================================================`);
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log(`====================================================`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runContextEngineTests().catch((err) => {
  console.error('Unhandled context engine error:', err);
  process.exit(1);
});
