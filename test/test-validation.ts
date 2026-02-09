// Test script for validate-frontend edge function
// Usage: deno run --allow-net --allow-read test-validation.ts

const SUPABASE_URL = "https://phfblljwuvzqzlbzkzpr.supabase.co";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function testValidation() {
  // Read test file
  const htmlContent = await Deno.readTextFile("./test-validation.html");

  // Also test a valid JS file
  const validJsContent = `
    const x = 1;
    const y = 2;
    console.log(x + y);
  `;

  // And an invalid JS file
  const invalidJsContent = `
    const broken = "unclosed string
    console.log('oops');
  `;

  const testCases = [
    {
      name: "HTML with syntax errors",
      files: [
        { path: "test.html", content: htmlContent }
      ],
      shouldPass: false
    },
    {
      name: "Valid JavaScript",
      files: [
        { path: "valid.js", content: validJsContent }
      ],
      shouldPass: true
    },
    {
      name: "Invalid JavaScript",
      files: [
        { path: "invalid.js", content: invalidJsContent }
      ],
      shouldPass: false
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n=== Testing: ${testCase.name} ===`);

    const response = await fetch(`${SUPABASE_URL}/functions/v1/validate-frontend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        work_order_id: "00000000-0000-0000-0000-000000000000", // Test UUID
        files: testCase.files,
      }),
    });

    const data = await response.json();
    const status = response.ok ? "✓" : "✗";

    console.log(`Status: ${status} (${response.status})`);
    console.log(`Valid: ${data.valid}`);
    console.log(`Files checked: ${data.files_checked}`);
    console.log(`Scripts checked: ${data.scripts_checked}`);

    if (data.errors && data.errors.length > 0) {
      console.log(`\nErrors found (${data.errors.length}):`);
      for (const error of data.errors) {
        console.log(`  - ${error.file}${error.script_block_index !== undefined ? ` (block ${error.script_block_index})` : ''}`);
        console.log(`    ${error.error.split('\n')[0]}`);
      }
    }

    const passed = (data.valid === testCase.shouldPass);
    console.log(`\nTest result: ${passed ? '✓ PASS' : '✗ FAIL'}`);
  }
}

testValidation().catch(console.error);
