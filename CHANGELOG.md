# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Design System: Enhanced Button component with new variants (ghost) and sizes (xs)
- Refactored core components to use the new Button system
- Initial setup of end-to-end tests with Playwright
- Basic tests for home page and video loading functionality
- Integration of tests in development process
- New "Position" section in Style tab for configuring subtitle X and Y position on screen
- Improved text alignment with support for left, center, and right, including text background
- Enhanced text transformation controls with intuitive icons for normal, uppercase and lowercase options
- Enhanced DraggableNumberInput with keyboard arrow controls and visual progress indicator
- Added support for displaying multiple subtitles simultaneously (up to 3 lines) with synchronized group animations
- Sistema de presets de estilos para subtítulos
  - Preset predeterminado "Edu Siverio"
  - Guardado y carga de presets personalizados
  - Gestión de presets (crear, eliminar)
  - Persistencia en localStorage

### Fixed
- Improved UI consistency: dark theme scrollbars, checkbox alignment, and focus management
- Fixed Accordion animations and height calculations
- Fixed video FPS detection in ExportButton
- Fixed subtitle textareas to automatically adjust their height based on content
- Fixed subtitle grouping not updating when adding new subtitles
- Fixed subtitle grouping logic to correctly respect the maximum number of lines setting
- Fixed subtitle groups not forming correctly when adding new subtitles at the start
- Fixed empty subtitles and empty lines being rendered unnecessarily

### Changed
- Improved Accordion animation using CSS grid-template-rows for smoother transitions
- Added data-testid to main components to facilitate testing
- Improved subtitle grouping algorithm for better accuracy and performance
- Refactored subtitle grouping logic to be more deterministic and consistent

## [0.1.0] - 2024-03-20

### Added
- Initial project setup with Next.js 14
- Base video editor components
- Subtitle editing system
- Tailwind CSS integration
- Initial project documentation
- Development guidelines and code standards 

### Fixed
- Removed unused variables in generate-subtitles route and ExportButton component 
- Fixed subtitle deletion functionality (both delete button and Delete key) 