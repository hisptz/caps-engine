## [3.1.2](https://github.com/hisptz/caps-engine/compare/v3.1.1...v3.1.2) (2026-10-28)

### Bug Fixes

- read the CHAP job status from the whole job as well as the bare string ([#15](https://github.com/hisptz/caps-engine/issues/15)) ([50d8c3b](https://github.com/hisptz/caps-engine/commit/50d8c3bbbf182ed7d782b17d4cb561b1eb03a36d)), closes [dhis2-chap/chap-core#786](https://github.com/dhis2-chap/chap-core/issues/786)

## [3.1.1](https://github.com/hisptz/caps-engine/compare/v3.1.0...v3.1.1) (2026-10-27)

### Bug Fixes

- notification url bug and improving error handling for rabbitMQ connection ([#14](https://github.com/hisptz/caps-engine/issues/14)) ([a8cd6d3](https://github.com/hisptz/caps-engine/commit/a8cd6d327234d74bb183fbc41102f4522c75731f))

# [3.1.0](https://github.com/hisptz/caps-engine/compare/v3.0.0...v3.1.0) (2026-10-22)

### Features

- Support for notification trigger and pushing data to other instances ([#12](https://github.com/hisptz/caps-engine/issues/12)) ([9ecb035](https://github.com/hisptz/caps-engine/commit/9ecb0354fbc48b288569e1531d53732a953c18f0))

# [3.0.0](https://github.com/hisptz/caps-engine/compare/v2.0.0...v3.0.0) (2026-10-14)

- fix!: name an Open Climate Service export in climate-openeo-create ([616bede](https://github.com/hisptz/caps-engine/commit/616bede4ef82457b3710cf24d68e48c3144fb2ea))

### Bug Fixes

- download the result asset an Open Climate Service job lists ([a5132d6](https://github.com/hisptz/caps-engine/commit/a5132d64463d5248f0c206a5d1d4cff819986a6d))
- skip non-area org units in climate-openeo-create ([9a24bed](https://github.com/hisptz/caps-engine/commit/9a24bed1aa32db01a8d3f22a359bbaf386c5a5f2))

### Features

- implement climate job tracking and management system ([83f901e](https://github.com/hisptz/caps-engine/commit/83f901e7ffe43b0611831c152067a761d80a8677))
- let climate-openeo-create cover the last N days ([d5868d7](https://github.com/hisptz/caps-engine/commit/d5868d78df9e5578bd820ae3e15688b4551b7e85))
- let climate-openeo-create take a data element or an OCS export ([5c5a971](https://github.com/hisptz/caps-engine/commit/5c5a9717b290c23a9104b96ec44edf4cb330ad7e))
- rolling periods for climate-openeo-create ([988d325](https://github.com/hisptz/caps-engine/commit/988d3251a872aede097a87a24d84e62874b5517d))

### BREAKING CHANGES

- climate-openeo-create's config replaces variable.dataElement
  with exportId, the id of an export under exports in the OCS instance config.

# [2.0.0](https://github.com/hisptz/caps-engine/compare/v1.3.0...v2.0.0) (2026-10-06)

- feat!: cross-instance DHIS2 data pull ([48f80dd](https://github.com/hisptz/caps-engine/commit/48f80dd547407daa1cc8a3524a5f971736bad11f))

### BREAKING CHANGES

- adds source-instance pull support for ingesting data from other DHIS2 instances

# [1.3.0](https://github.com/hisptz/caps-engine/compare/v1.2.0...v1.3.0) (2026-09-27)

### Features

- implement Open Climate Service sync handler with configuration and job management ([c6ec234](https://github.com/hisptz/caps-engine/commit/c6ec234c2e0b0e558ad8a501444452f11bb4588b))

# [1.2.0](https://github.com/hisptz/caps-engine/compare/v1.1.0...v1.2.0) (2026-09-23)

### Features

- enhance prediction trigger configuration and error handling in evaluations ([69e7cbc](https://github.com/hisptz/caps-engine/commit/69e7cbc430d02354a8b69374e7da48c5fcb6ac26))

# [1.1.0](https://github.com/hisptz/caps-engine/compare/v1.0.0...v1.1.0) (2026-09-23)

### Features

- add caps_outputs volume for worker and scheduler services ([b4e0884](https://github.com/hisptz/caps-engine/commit/b4e08848b3bd4745c3aa14f67874dce3c2638de3))

# 1.0.0 (2026-09-17)

### Features

- initial release ([a95dcf8](https://github.com/hisptz/caps-engine/commit/a95dcf888ea575f82e991c4ad3dc2d942050585b))
