# Flutter Reference

Load this file when working on Flutter/Dart projects. It supplements the main coding-standards SKILL.md.

---

## Project Structure

```
lib/
├── main.dart
├── app/
│   ├── app.dart              # Root widget, router setup
│   └── router.dart           # GoRouter configuration
├── features/
│   └── registration/
│       ├── data/
│       │   ├── repositories/
│       │   └── datasources/
│       ├── domain/
│       │   ├── models/
│       │   └── repositories/ # Abstract interfaces
│       └── presentation/
│           ├── screens/
│           ├── widgets/      # Feature-specific widgets
│           └── providers/    # Riverpod providers
├── shared/
│   ├── widgets/              # App-wide shared widgets
│   ├── utils/
│   └── constants/
└── core/
    ├── network/
    ├── storage/
    └── theme/
```

---

## State Management (Riverpod)

- Use Riverpod (code-gen flavor: `@riverpod`) for all state
- Never use `setState` for anything beyond purely local ephemeral UI state (e.g. a toggle within a single widget)
- Provider types by use case:
  - `@riverpod` (AutoDispose) — default for most providers; disposed when no longer listened
  - `@Riverpod(keepAlive: true)` — for global persistent state (auth, app config)
  - `AsyncNotifierProvider` — for async data with loading/error states
  - `StreamProvider` — for real-time data streams

```dart
// Pattern to follow
@riverpod
Future<List<Student>> students(StudentsRef ref) async {
  return ref.watch(studentRepositoryProvider).getAll();
}
```

---

## Offline-First Architecture

- Every feature that operates in the field must work fully offline
- Local-first: all reads come from local DB first; network is a sync mechanism, not a dependency
- Use Isar or Drift for structured local storage — choose Isar for simple models, Drift for relational data with complex queries
- Sync strategy: opportunistic — sync when connectivity is detected, queue writes locally when offline
- Conflict resolution must be defined explicitly per entity — never silently overwrite server data

---

## Widget Rules

- One widget per file, same as components in React
- Widgets that are only used by one screen live beside that screen in a `widgets/` subfolder
- Never build a widget that exceeds ~100 lines of `build()` — decompose it
- Prefer `const` constructors wherever possible — it signals immutability and enables Flutter's optimization
- Use `CustomScrollView` + `Slivers` for complex scrolling layouts, not nested `ListView`s

---

## Forms

- Use `flutter_form_builder` or manual `TextEditingController` with `Form` + `GlobalKey<FormState>`
- Validation logic lives in dedicated validator functions, not inline in the `validator` callback
- Dispose all controllers in `dispose()` — no exceptions

---

## Navigation

- GoRouter for all routing
- Route definitions live in `app/router.dart` as a single source of truth
- Use typed route parameters — never raw `Map<String, String>` query params in business logic
- Guard routes with `redirect` in GoRouter for auth checks

---

## Environment & Config

- Use `--dart-define-from-file=env.json` for environment variables
- Never hardcode API URLs or keys in source files
- A `.env.example.json` lives in the repo root documenting required variables

---

## ML Kit / OCR

- ML Kit processing happens in an isolate or `compute()` function — never on the main thread
- OCR results are always treated as unvalidated strings; run through field-specific parsers before use
- Provide a manual correction UI whenever OCR fills a form field — never trust OCR output blindly
