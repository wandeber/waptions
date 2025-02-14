# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Design System: Added base Button component with variants and sizes
- Design System: Added new 'ghost' variant for transparent buttons
- Design System: Added new 'xs' size for smaller buttons
- Refactored Timeline component to use the new Button component
- Refactored SubtitleEditor to use the new Button variants
- Refactored ExportButton to use the new Button component

### Fixed
- Fixed video FPS detection in ExportButton to use detected FPS instead of resolution-based calculation
- Customized scrollbars to match dark theme using bg-gray-800 for track and bg-gray-700 for thumb

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