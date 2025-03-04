/**
 * A wrapper for diff_match_patch that works in both module and non-module contexts
 */

// First try to load the existing diff_match_patch if it's already defined
let diffMatchPatchClass;

if (typeof diff_match_patch !== 'undefined') {
  diffMatchPatchClass = diff_match_patch;
  console.log('Using global diff_match_patch');
} else {
  // Load diff_match_patch.js script content here
  // This is the fallback implementation if needed
  // It should be the content of diff_match_patch.js
  
  /**
   * Placeholder for compatibility - in the actual implementation, 
   * you would include the diff_match_patch code here
   */
  console.warn('diff_match_patch not found, using placeholder');
  
  // A minimal implementation to prevent errors
  diffMatchPatchClass = class DiffMatchPatch {
    constructor() {
      console.warn('Using minimal DiffMatchPatch placeholder');
    }
    
    diff_main(text1, text2) {
      console.warn('diff_main called with placeholder implementation');
      return [[-1, text1], [1, text2]];
    }
    
    diff_cleanupSemantic(diffs) {
      // No-op in this placeholder
    }
    
    diff_prettyHtml(diffs) {
      return `<div class="error">DiffMatchPatch not properly loaded</div>`;
    }
  };
}

// Create a consistent export that works in all environments
const DiffMatchPatch = diffMatchPatchClass;

// For ES modules
export default DiffMatchPatch;

// For CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiffMatchPatch;
}

// For global use
if (typeof window !== 'undefined') {
  window.DiffMatchPatch = DiffMatchPatch;
}
