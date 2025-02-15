# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Design System: Enhanced Button component with new variants (ghost) and sizes (xs)
- Refactored core components to use the new Button system
- Configuración inicial de tests end-to-end con Playwright
- Tests básicos para la página principal y funcionalidad de carga de vídeos
- Integración de tests en el proceso de desarrollo

### Fixed
- Improved UI consistency: dark theme scrollbars, checkbox alignment, and focus management
- Fixed Accordion animations and height calculations
- Fixed video FPS detection in ExportButton

### Changed
- Improved Accordion animation using CSS grid-template-rows for smoother transitions
- Añadidos data-testid a componentes principales para facilitar testing

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