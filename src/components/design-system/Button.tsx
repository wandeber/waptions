'use client';

import { ButtonHTMLAttributes, ReactNode } from 'react';

// Button variants
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'info' | 'success';

// Button sizes
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

// Props interface extending HTML button attributes
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  isActive?: boolean;
}

// Base button component
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  isActive = false,
  className = '',
  ...props
}: ButtonProps) {
  // Base styles
  const baseStyles = 'rounded transition-colors select-none flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';

  // Variant styles with active states
  const variantStyles = {
    primary: isActive
      ? 'bg-blue-700 hover:bg-blue-600 text-white'
      : 'bg-blue-600 hover:bg-blue-700 text-white',
    secondary: isActive
      ? 'bg-gray-500 hover:bg-gray-400 text-gray-300'
      : 'bg-gray-600 hover:bg-gray-500 text-gray-300',
    danger: isActive
      ? 'bg-red-800 hover:bg-red-700 text-gray-300'
      : 'bg-red-700 hover:bg-red-600 text-gray-300',
    ghost: isActive
      ? 'hover:bg-gray-600 text-gray-300'
      : 'hover:bg-gray-600 text-gray-300',
    info: isActive
      ? 'bg-sky-700 hover:bg-sky-600 text-white'
      : 'bg-sky-600 hover:bg-sky-700 text-white',
    success: isActive
      ? 'bg-green-700 hover:bg-green-600 text-white'
      : 'bg-green-600 hover:bg-green-700 text-white'
  };

  // Size styles
  const sizeStyles = {
    xs: 'p-0.5',
    sm: 'p-1',
    md: 'px-3 py-1',
    lg: 'px-4 py-2'
  };

  // Combine all styles
  const finalStyles = `${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`;

  return (
    <button className={finalStyles} {...props}>
      {children}
    </button>
  );
} 