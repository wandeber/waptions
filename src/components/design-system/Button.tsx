'use client';

import { ButtonHTMLAttributes, ReactNode } from 'react';

// Button variants
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

// Button sizes
export type ButtonSize = 'sm' | 'md' | 'lg';

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
  const baseStyles = 'rounded transition-colors select-none';

  // Variant styles with active states
  const variantStyles = {
    primary: isActive 
      ? 'bg-red-700 hover:bg-red-600 text-gray-300'
      : 'bg-gray-700 hover:bg-gray-600 text-gray-300',
    secondary: isActive
      ? 'bg-gray-500 hover:bg-gray-400 text-gray-300'
      : 'bg-gray-600 hover:bg-gray-500 text-gray-300',
    danger: isActive
      ? 'bg-red-800 hover:bg-red-700 text-gray-300'
      : 'bg-red-700 hover:bg-red-600 text-gray-300'
  };

  // Size styles
  const sizeStyles = {
    sm: 'p-1',
    md: 'p-1.5',
    lg: 'p-2'
  };

  // Combine all styles
  const finalStyles = `${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`;

  return (
    <button className={finalStyles} {...props}>
      {children}
    </button>
  );
} 