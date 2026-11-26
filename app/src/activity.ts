// Turns the agent's tool calls (from Claude's stream) into plain words for the live cards. Pure.
// Returns null for calls not worth showing (the jobbot tools draw their own UI).

const CLI: [RegExp, string | null][] = [
  [/\brepair start\b/, 'Setting up a place to work on the fix'],
  [/\brepair test\b/, 'Running the tests on the fix'],
  [/\brepair prepare\b/, 'Getting the fix ready for your review'],
  [/\bjob new\b/, 'Saving the job'],
  [/\bfetch\b/, 'Downloading the posting'],
  [/\binspect\b/, 'Reading the application form'],
  [/\bresolve\b/, "Looking for the employer's own application form"],
  [/\bcanary\b/, 'Checking that form filling still works'],
  [/\bprofile (show|answer list|answer get)\b/, 'Checking your profile and saved answers'],
  [/\bprofile write-draft\b/, 'Saving your profile'],
  [/\bprofile answer set\b/, 'Saving your answer for next time'],
  [/\bresume bank\b/, 'Gathering the lines from all your resume versions'],
  [/\bresume outline\b/, 'Studying the layout of your resume'],
  [/\bresume import\b/, 'Importing your resume'],
  [/\bresume-check\b/, 'Checking how your resume renders'],
  [/\btailor\b.*--fallback/, 'Using your original resume unchanged'],
  [/\btailor\b/, 'Building your tailored resume and checking the layout'],
  [/\bcover-letter\b/, 'Formatting your cover letter'],
  [/\bfill\b/, 'Filling in the application form in a hidden browser'],
  [/\breview build\b/, 'Putting your review together'],
  [/\bjob set-status \S+ SKIPPED\b/, 'Skipping this job'],
  [/\bjob set-status\b/, null],
  [/\bjob (get|list)\b/, null],
  [/\bdiscover poll\b/, 'Checking the companies you watch for new openings'],
  [/\bboards add\b/, 'Adding new companies to watch'],
  [/\bboards (list|check)\b/, 'Looking at the companies you watch'],
  [/\blog\b/, null],
]

const FILES: [RegExp, string | null][] = [
  [/repair\/[^/]+\/work\//, 'Changing the code'],
  [/repair\/[^/]+\/logs\.txt$/, 'Reading the logs'],
  [/repair\/[^/]+\/report\.json$/, 'Writing up the fix'],
  [/company\.json$/, 'Writing down what I found about the company'],
  [/analysis\.json$/, 'Reading the job analysis'],
  [/profile\.md$/, 'Reading your profile'],
  [/resume_text\.txt$/, 'Reading your resume'],
  [/resumes[\\/][^\\/]+\.txt$/, 'Reading your other resume versions'],
  [/posting\.md$/, 'Reading the job posting'],
  [/fields\.json$/, 'Reading the form fields'],
  [/settings\.json$/, 'Checking your search settings'],
  [/review\.json$/, 'Checking the prepared application'],
  [/SKILL\.md$/, null],
]

const SKILLS: Record<string, string> = { // job, resume, revise and followup work runs in the app's own code (pipeline.ts)
  'discover-jobs': 'Looking for new jobs',
  'repair-app': 'Looking into the problem',
  'interview-prep': 'Building your interview prep',
  'company-researcher': 'Reading about the company',
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function describe(name: string, input: Record<string, any> = {}): string | null {
  if (name.startsWith('mcp__')) return null
  if (name === 'Bash') {
    const cmd = String(input.command ?? '')
    if (!/jobagent/.test(cmd)) return 'Running a helper command'
    for (const [re, text] of CLI) if (re.test(cmd)) return text
    return 'Running a helper command'
  }
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const p = String(input.file_path ?? '').replace(/\\/g, '/')
    for (const [re, text] of FILES) if (re.test(p)) return text
    return name === 'Read' ? 'Reading notes' : 'Writing notes'
  }
  if (name === 'Task' || name === 'Agent') return 'Reading about the company' // the only subagent left: company-researcher (prep)
  if (name === 'Skill') return SKILLS[String(input.skill ?? input.command ?? '')] ?? null
  if (name === 'WebSearch') return `Searching the web: ${clip(String(input.query ?? ''))}`
  if (name === 'Glob' || name === 'Grep') return 'Looking through your files'
  return null
}
