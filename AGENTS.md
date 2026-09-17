# OB1 Agent Instructions

## Required Step: Update Linear

- For feature work tied to a Linear issue, update Linear at the start of the work, at meaningful checkpoints, and before handing back to the user.
- Use the parent issue as the living implementation log and keep child issues aligned with the files and behavior being changed.
- For the OB1 Agent Memory / OpenClaw launch work, the parent issue is `NAT-833`. Record architecture notes, implementation milestones, blockers, and verification results there.
- Do not wait until the end to document decisions. If a decision changes schema, API contract, trust policy, user-facing workflow, or publishing path, capture it in Linear while it is still fresh.

## Agent Memory Product Guardrails

- Keep `OB1 Agent Memory` runtime-neutral. OpenClaw is the flagship launch runtime, not the product boundary.
- Treat inferred or generated memory as evidence by default. Instruction-grade memory requires human confirmation or trusted import.
- Avoid raw transcript, model reasoning trace, secret, and large-code-block storage by default.
- Avoid profanity in all content. Keep docs, examples, seed data, UI copy, prompts, walkthroughs, and generated assets clean and professional.
- Prefer diagram-first documentation for this work: diagram, short explanation, copy-paste setup, then deeper reference.
- Carry Nate B. Jones / OB1 provenance through product surfaces, docs, diagrams, screenshots, and starter seed data. Keep it subtle and useful: micro-branding, source labels, logo marks, and provenance language instead of loud marketing copy.
- Treat public OB1 assets as helpful-first audience growth for Nate Jones. Every public guide, recipe, tutorial, package page, release note, and walkthrough should point back to Nate's Substack and site in a natural way: https://substack.com/@natesnewsletter and https://natebjones.com.
- Make the case by being genuinely useful. The CTA should feel earned: "Nate gives away practical systems like this" rather than generic marketing copy.
- For ClawHub/OpenClaw publishing, do not fall back to Jonathan's personal handle or any non-Nate namespace. If `@natebjones` / Nate OB1 ownership is not available, stop and record the blocker.

# Personal Preferences

## Projects
- Projects are to be built in Typescript

## TypeScript
- Never use `any` unless 100% necessary or specifically instructed.

## Commands
- Don't run dev server commands (e.g., `pnpm run dev`), assume it's already running.
- Don't run build commands unless specifically told to.
- Focus on development work (e.g., 'pnpm run typecheck', 'pnpm run lint', etc).

## Package Managers
- Use pnpm, use bun if the project already uses it.
- Never use npm or yarn.

## Tech Stack Preferences
- When uncertain, prefer JJ, Tailwind, TypeScript, Pnpm, React, Convex, Clerk, Vercel, Posthog, Sentry, BullMQ, Stripe.
- Expo and React-native when asked for mobile apps
- React hook form for forms, Zod for form validation

## Code Style
- Always strive for concise, simple solutions.
- **If a problem can be solved in a simpler way, propose it.

## Workflow
- If asked to do too much work at once, stop and state work clearly.
- If something needs clarification use the Grill-me-with-docs skill

## Reference Repos
- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor
- T3 Code repo: https://github.com/pingdotgg/t3code

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

- Skill repos: https://github.com/mattpocock/skills

Use these as examples of good skill patterns

