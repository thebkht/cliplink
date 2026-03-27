This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Next.js 15 application (not the standard Next.js, it has breaking changes per the AGENTS.md). The project is  
 located at `/Users/thebkht/Projects/cliplink`.

## Commands Reference

- **Build**: `npm run build`
- **Dev server**: `npm run dev`
- **Lint**: `npm run lint`
- **Type check**: `npm run type-check`
- **Test**: `npm test`
- **Run single test**: `npm test -- -t <pattern>`
- **Test with coverage**: `npm test -- --coverage`
- **Format**: `npm run format`
- **Format check**: `npm run format:check`  


## Architecture

### High-Level Structure

src/  
 ├── app/ # Next.js App Router pages and layouts
│ ├── layout.tsx # Root layout with providers  
 │ ├── page.tsx # Home page  
 │ ├── globals.css # Global styles  
 │ └── api/ # API routes (if any)  
 ├── components/ # React components (UI, features)  
 │ └── ui/ # UI component library  
 ├── hooks/ # Custom React hooks  
 ├── lib/ # Utility libraries and helpers  
 ├── server/ # Server-side utilities (if any)  
 ├── utils/ # Utility functions  
 └── store/ # State management (if any)

### Key Technologies

- **Framework**: Next.js 15 with App Router
- **Styling**: Tailwind CSS
- **TypeScript**: Full type safety
- **State**: Custom store implementation (if applicable)
- **UI Components**: Custom UI component library
- **Database**: Prisma ORM (with SQLite as default, Postgres in development)
- **Authentication**: NextAuth.js (credentials strategy with cookies and headers)
- **AI Integration**: Vercel AI SDK for AI features
- **Validation**: Zod schemas for validation  


### Important Dependencies

Based on `package.json`:

- Next.js 15 framework
- Tailwind CSS for styling
- TypeScript for type checking
- ESM packages as specified in package.json
- Prisma ORM
- NextAuth.js for authentication
- Vercel AI SDK for AI features
- Zod for schema validation  


## Development Guidelines

### Component Development

1. **Component Structure**: All components should be in `src/components/` or `src/components/ui/`
2. **Type Safety**: All components must have proper TypeScript types
3. **Styling**: Use Tailwind CSS utility classes
4. **Props**: Use proper TypeScript interfaces for component props
5. **Accessibility**: Ensure components are accessible (ARIA attributes where needed)
6. **Naming**: Use descriptive, PascalCase names for components and camelCase for props
7. **Error Handling**: Implement error boundaries in critical components  


### Page Development

1. **Page Structure**: Follow the layout.tsx structure with consistent navigation
2. **Type Safety**: Define page props and search parameters with proper types
3. **Metadata**: Implement proper SEO metadata for each page
4. **Navigation**: Use consistent navigation patterns (navbar, footer, breadcrumbs)
5. **Loading States**: Implement loading and error states for async operations
6. **Responsive Design**: Ensure mobile-first responsive design with Tailwind  


### API Routes (if applicable)

1. Use Next.js App Router API routes in `src/app/api/`
2. Proper error handling and validation with Zod schemas
3. Request and response type safety
4. Consider caching strategies where appropriate
5. Implement proper authentication for protected routes
6. Use consistent response formats (JSON with appropriate status codes)
7. Log appropriate debug/trace events for monitoring  


### Authentication Implementation

1. Use NextAuth.js with credentials strategy (cookies and headers)
2. Implement session management with secure cookies
3. Create login/logout routes with proper CSRF protection
4. Implement middleware for protecting routes that require authentication
5. Handle OAuth providers as configured in .env.local
6. Validate user sessions on route requests  


### State Management (if applicable)

1. Use the store implementation from `src/store/` if present
2. Follow established patterns for state actions
3. Keep state management modular and testable
4. Consider React Context for simple state needs  


## Common Tasks

### Adding a New Component

1. Create component in `src/components/` or `src/components/ui/` for UI components
2. Define proper TypeScript types for props
3. Use Tailwind CSS for styling
4. Add error handling and accessibility attributes
5. Create or update tests as needed  


### Adding a New Page

1. Create page in `src/app/` directory
2. Define page props with proper TypeScript types
3. Follow layout.tsx structure with consistent navigation
4. Implement proper SEO metadata
5. Use appropriate API routes if needed
6. Create tests for critical functionality  


### Adding an AI Feature

1. Use Vercel AI SDK (useChat, useCompletion, etc.)
2. Define proper streaming responses for better UX
3. Handle streaming errors appropriately
4. Implement rate limiting for AI calls
5. Cache AI responses where appropriate  


### Adding Database Schema

1. Update Prisma schema in `prisma/schema.prisma`
2. Run migrations: `npm run db:migrate`
3. Generate Prisma client: `npm run db:generate`
4. Ensure proper relationships and constraints  


### Fixing TypeScript Errors

1. Run `npm run type-check` to identify all type issues
2. Fix types in component props and functions
3. Ensure proper imports and exports
4. Check for missing type definitions
5. Use type assertions sparingly and document them  


### Updating Dependencies

1. Review `package.json` for dependency versions
2. Consider compatibility with ESM/ESM packages
3. Follow semantic versioning best practices
4. Update `package-lock.json` or `yarn.lock` as appropriate
5. Test thoroughly after dependency updates  


## Environment Variables

The project uses environment variables (typically in `.env.local`):

- Database connection string or Prisma config
- API keys for external services
- Authentication credentials
- Configuration flags
- NextAuth configuration  


Example .env.local:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"
# Add other credentials here

Security Considerations

1. Validate all user inputs with Zod schemas
2. Use environment variables for secrets
3. Implement proper authentication with NextAuth
4. Sanitize any data returned to frontend
5. Follow Next.js security best practices
6. Implement CSRF protection for credential-based auth
7. Use secure cookie settings (HttpOnly, Secure, SameSite)
8. Implement rate limiting for API endpoints
9. Sanitize and validate AI responses
10. Implement proper error messages that don't leak sensitive information

Performance

1. Use Next.js built-in optimization features
2. Implement proper lazy loading for large components
3. Utilize Next.js caching mechanisms
4. Optimize images and assets with next/image
5. Monitor and address performance bottlenecks
6. Use React.memo for expensive components
7. Implement server components where appropriate
8. Optimize database queries with Prisma indexing

Code Style

1. TypeScript: Full type safety throughout the codebase
2. Formatting: Follow standard TypeScript/JavaScript formatting
3. Comments: Add comments for complex logic
4. Documentation: Document public APIs and non-obvious implementations
5. Naming: Use descriptive, camelCase names for variables and functions
6. File Organization: Keep files focused and single-responsibility
7. Imports: Group imports (third-party, internal, types)
8. Error Handling: Use try/catch with proper error messages

Error Handling

1. Use proper error boundaries in React components
2. Implement comprehensive error handling in API routes
3. Log errors appropriately without exposing sensitive data
4. Provide meaningful error messages to users
5. Use appropriate HTTP status codes
6. Implement client-side error handling for network issues
7. Create user-friendly error states in UI

Browser Support

Ensure compatibility with modern browsers as per Next.js requirements:
- Chrome/Edge (latest 2 versions)
- Firefox (latest 2 versions)
- Safari (latest 2 versions)
- Mobile browsers (iOS Safari, Chrome Mobile)

```
