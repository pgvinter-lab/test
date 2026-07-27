import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Projections } from '../../dist/caps/projections.js';
import { initializeNeedsProfile } from '../../dist/caps/needs-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFreshTempDir() {
  const dir = path.join(__dirname, '..', '..', 'temp', 'projections_' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('1. Needs no-overwrite (preserve existing bytes)', () => {
  const tempDir = getFreshTempDir();
  const needsPath = path.join(tempDir, 'NEEDS.json');
  fs.writeFileSync(needsPath, JSON.stringify({
    schema: 'bridge-caps-needs-v1',
    profile_id: 'existing',
    owner_managed: true,
    updated_at: '2026-07-24T00:00:00.000Z',
    provenance: {
      source_path: 'caps/needs-profile.ts',
      source_section: 'SEEDED_NEEDS',
      source_sha256: 'a'.repeat(64),
      observed_at: '2026-07-24T00:00:00.000Z',
      capture_class: 'guaranteed',
      producer_surface: 'code'
    },
    needs: []
  }));
  const sourcePath = path.join(tempDir, 'source.ts');
  fs.writeFileSync(sourcePath, 'test content');
  const sourceSha256 = crypto.createHash('sha256').update('test content').digest('hex');
  const res = initializeNeedsProfile(needsPath, sourcePath, 's', sourceSha256, '2026-07-24T00:00:00.000Z');
  assert.strictEqual(res.profile_id, 'existing');
  cleanupTempDir(tempDir);
});

test('2. Needs exclusive create seeds exactly 4 needs', () => {
  const tempDir = getFreshTempDir();
  const needsPath = path.join(tempDir, 'NEEDS_NEW.json');
  const sourcePath = path.join(tempDir, 'source2.ts');
  fs.writeFileSync(sourcePath, 'test content 2');
  const sourceSha256 = crypto.createHash('sha256').update('test content 2').digest('hex');
  const res = initializeNeedsProfile(needsPath, sourcePath, 'test-sec', sourceSha256, '2026-07-24T00:00:00.000Z');
  assert.strictEqual(res.needs.length, 4);
  assert.strictEqual(res.provenance.source_path, sourcePath);
  cleanupTempDir(tempDir);
});

test('3. Marker case 1: normal replace', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat1.md');
  const fix = path.join(__dirname, '..', 'fixtures', 'caps', 'catalog-owner-content.md');
  fs.copyFileSync(fix, target);
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.ok(res.receipt.startsWith('backed_up_'));
  assert.ok(!res.error);
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('<!-- bridge:caps:generated:begin -->\nGENERATED\n<!-- bridge:caps:generated:end -->') || content.includes('<!-- bridge:caps:generated:begin -->\r\nGENERATED\r\n<!-- bridge:caps:generated:end -->'));
  cleanupTempDir(tempDir);
});

test('4. Marker case 2: append when both absent', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat2.md');
  fs.writeFileSync(target, 'Just some text');
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.ok(!res.error);
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('Just some text\n<!-- bridge:caps:generated:begin -->') || content.includes('Just some text\r\n<!-- bridge:caps:generated:begin -->'));
  cleanupTempDir(tempDir);
});

test('5. Marker case 3: duplicate markers rejected', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat3.md');
  fs.writeFileSync(target, '<!-- bridge:caps:generated:begin --><!-- bridge:caps:generated:begin -->');
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.strictEqual(res.error, 'duplicate_markers');
  assert.strictEqual(res.receipt, 'error_no_backup');
  cleanupTempDir(tempDir);
});

test('6. Marker case 4: begin only marker rejected', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat4.md');
  fs.writeFileSync(target, '<!-- bridge:caps:generated:begin -->');
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.strictEqual(res.error, 'begin_only_marker');
  assert.strictEqual(res.receipt, 'error_no_backup');
  cleanupTempDir(tempDir);
});

test('7. Marker case 5: end only marker rejected', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat5.md');
  fs.writeFileSync(target, '<!-- bridge:caps:generated:end -->');
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.strictEqual(res.error, 'end_only_marker');
  assert.strictEqual(res.receipt, 'error_no_backup');
  cleanupTempDir(tempDir);
});

test('8. Marker case 6: reversed markers rejected', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat6.md');
  fs.writeFileSync(target, '<!-- bridge:caps:generated:end --><!-- bridge:caps:generated:begin -->');
  const proj = new Projections(tempDir);
  const res = proj.spliceCatalog(target, 'GENERATED');
  assert.strictEqual(res.error, 'reversed_markers');
  assert.strictEqual(res.receipt, 'error_no_backup');
  cleanupTempDir(tempDir);
});

test('9. Owner bytes preservation', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat7.md');
  const fix = path.join(__dirname, '..', 'fixtures', 'caps', 'catalog-owner-content.md');
  fs.copyFileSync(fix, target);
  const proj = new Projections(tempDir);
  proj.spliceCatalog(target, 'GENERATED');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('This is an owner section outside the markers.'));
  assert.ok(content.includes('Another owner section at the end.'));
  cleanupTempDir(tempDir);
});

test('10. Line endings preservation', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat8.md');
  fs.writeFileSync(target, 'A\r\n<!-- bridge:caps:generated:begin -->\r\nB\r\n<!-- bridge:caps:generated:end -->\r\nC');
  const proj = new Projections(tempDir);
  proj.spliceCatalog(target, 'GENERATED');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('A\r\n'));
  assert.ok(content.includes('\r\nC'));
  cleanupTempDir(tempDir);
});

test('11. Backups and manifest hash', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat9.md');
  fs.writeFileSync(target, 'Original Content');
  const proj = new Projections(tempDir);
  proj.spliceCatalog(target, 'GENERATED');

  const backupsDir = path.join(tempDir, 'backups', 'projections');
  const files = fs.readdirSync(backupsDir);
  assert.ok(files.some(f => f.startsWith('cat9.md') && f.endsWith('.bak')));
  assert.ok(files.some(f => f.startsWith('cat9.md') && f.endsWith('.manifest')));

  const manifestFile = files.find(f => f.endsWith('.manifest') && f.startsWith('cat9.md'));
  const manifest = fs.readFileSync(path.join(backupsDir, manifestFile), 'utf8');
  const hash = crypto.createHash('sha256').update('Original Content').digest('hex');
  assert.ok(manifest.includes(hash));
  cleanupTempDir(tempDir);
});

test('12. Injected failure leaves target intact', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'cat10.md');
  fs.writeFileSync(target, 'Original');
  const proj = new Projections(tempDir);

  const orig = proj['writeAtomic'];
  proj['writeAtomic'] = () => { throw new Error("Injected fail"); };

  try {
    proj.spliceCatalog(target, 'GENERATED');
  } catch (e) {
    assert.strictEqual(e.message, "Injected fail");
  }

  const content = fs.readFileSync(target, 'utf8');
  assert.strictEqual(content, 'Original');
  proj['writeAtomic'] = orig;
  cleanupTempDir(tempDir);
});

test('13. Paid-last ordering in rendering', () => {
  const tempDir = getFreshTempDir();
  const proj = new Projections(tempDir);
  const rows = [
    { pricing: 'paid', name: 'Z_Paid' },
    { pricing: 'free', name: 'Z_Free' },
    { pricing: 'unknown', name: 'A_Unknown' }
  ];
  const fullRows = rows.map(r => ({ ...r, slug: r.name, surface_owner: 'agy', capture_class: 'reported', last_verified: '2020', stale_at: '2020' }));
  const res = proj.renderCatalogSection(fullRows, []);

  const freeIdx = res.indexOf('Z_Free');
  const unkIdx = res.indexOf('A_Unknown');
  const paidIdx = res.indexOf('Z_Paid');

  assert.ok(freeIdx < unkIdx);
  assert.ok(unkIdx < paidIdx);
  cleanupTempDir(tempDir);
});

test('14. Verdict rendering in generated available', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'avail1.md');
  const proj = new Projections(tempDir);
  const avRows = [
    { pricing: 'free', name: 'Test', slug: 'test', judgment_verdict: 'PASS_APPROVED' }
  ];
  proj.generateAvailable(target, avRows, [], avRows, 0, 0, [{ query: 'test', expected_count: 1, found_count: 1 }], ['hash1']);

  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes('PASS_APPROVED'));
  assert.ok(content.includes('hint-not-proof'));
  cleanupTempDir(tempDir);
});

test('15. F1 mismatch rejection/no target creation', () => {
  const tempDir = getFreshTempDir();
  const needsPath = path.join(tempDir, 'NEEDS.json');
  const sourcePath = path.join(tempDir, 'source.ts');
  fs.writeFileSync(sourcePath, 'test content');
  try {
    initializeNeedsProfile(needsPath, sourcePath, 's', 'a'.repeat(64), '2026-07-24T00:00:00.000Z');
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.message, 'source_hash_mismatch');
  }
  assert.ok(!fs.existsSync(needsPath));
  cleanupTempDir(tempDir);
});

test('16. generateAvailable returns receipt', () => {
  const tempDir = getFreshTempDir();
  const target = path.join(tempDir, 'avail2.md');
  const proj = new Projections(tempDir);
  const res1 = proj.generateAvailable(target, [], [], [], 0, 0, [], ['hash1']);
  assert.strictEqual(res1.receipt, 'no_prior_file');

  const res2 = proj.generateAvailable(target, [], [], [], 0, 0, [], ['hash1']);
  assert.ok(res2.receipt.startsWith('backed_up_'));
  cleanupTempDir(tempDir);
});
