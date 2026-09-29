// scratch/test_parser.js
const assert = require('assert');

const state = {
  currentQuizQuestions: []
};

function parseQuizResponse(input, userMessage) {
  if (input && typeof input === 'object') {
    if (Array.isArray(input.questions)) {
      state.currentQuizQuestions = input.questions;
      return;
    }
    if (Array.isArray(input)) {
      state.currentQuizQuestions = input;
      return;
    }
  }

  const rawAiString = String(input || '');
  const startIndex = rawAiString.indexOf("START_QUIZ");
  const cleanedOutput = startIndex !== -1 ? rawAiString.substring(startIndex) : rawAiString;
  const questionBlocks = cleanedOutput.split("END_QUESTION").filter(block => block.includes("[Q]"));
  
  const parsedQuestions = questionBlocks.map((block, index) => {
      const getTagContent = (tag) => {
          const startIdx = block.indexOf(tag);
          if (startIdx === -1) return "";
          const endIdx = block.indexOf("\n", startIdx);
          return block.substring(startIdx + tag.length, endIdx !== -1 ? endIdx : block.length).trim();
      };

      const questionText = getTagContent("[Q]");
      const optA = getTagContent("[A]");
      const optB = getTagContent("[B]");
      const optC = getTagContent("[C]");
      const optD = getTagContent("[D]");
      const rawAns = getTagContent("[ANS]").toUpperCase();

      // Resolve literal option string matching to support existing grading algorithms
      let correctOptionText = optA;
      if (rawAns === "B") correctOptionText = optB;
      if (rawAns === "C") correctOptionText = optC;
      if (rawAns === "D") correctOptionText = optD;

      return {
          id: index + 1,
          difficulty: "easy",
          type: "mcq",
          question_text: questionText || "Verify concept baseline parameter.",
          options: [optA || "True", optB || "False", optC || "N/A", optD || "N/A"],
          correct_answer: correctOptionText || optA
      };
  });

  if (parsedQuestions.length === 0) {
      state.currentQuizQuestions = [{
          id: 1, difficulty: "easy", type: "mcq",
          question_text: "Confirm engine initialization to access your workspace session.",
          options: ["Initialize Space", "Cancel"],
          correct_answer: "Initialize Space"
      }];
  } else {
      state.currentQuizQuestions = parsedQuestions;
  }
}

// TEST CASE 1: Standard layout response (String)
const content1 = `
Here is your test database generation:

START_QUIZ
[Q] What is the capital of France?
[A] London
[B] Paris
[C] Berlin
[D] Madrid
[ANS] B
END_QUESTION

START_QUIZ
[Q] What is 2 + 2?
[A] 3
[B] 4
[C] 5
[D] 6
[ANS] B
END_QUESTION
`;

parseQuizResponse(content1, "General Knowledge");
console.log("Test 1 Result:", JSON.stringify(state.currentQuizQuestions, null, 2));

assert.strictEqual(state.currentQuizQuestions.length, 2);
assert.strictEqual(state.currentQuizQuestions[0].question_text, "What is the capital of France?");
assert.strictEqual(state.currentQuizQuestions[0].correct_answer, "Paris");

// TEST CASE 2: Empty/Malformed content (failover safe-gate check)
const content2 = `
Hello there! This has no question blocks.
`;
parseQuizResponse(content2, "Empty Test");
console.log("Test 2 (Fallback) Result:", JSON.stringify(state.currentQuizQuestions, null, 2));
assert.strictEqual(state.currentQuizQuestions.length, 1);
assert.strictEqual(state.currentQuizQuestions[0].question_text, "Confirm engine initialization to access your workspace session.");

// TEST CASE 3: Parsed JSON Object input
const content3 = {
  questions: [
    {
      id: 1,
      difficulty: "medium",
      type: "mcq",
      question_text: "What is the capital of Italy?",
      options: ["Milan", "Rome", "Naples", "Florence"],
      correct_answer: "Rome"
    }
  ]
};
parseQuizResponse(content3, "General Knowledge");
console.log("Test 3 (JSON Object) Result:", JSON.stringify(state.currentQuizQuestions, null, 2));
assert.strictEqual(state.currentQuizQuestions.length, 1);
assert.strictEqual(state.currentQuizQuestions[0].question_text, "What is the capital of Italy?");
assert.strictEqual(state.currentQuizQuestions[0].correct_answer, "Rome");

console.log("All parsing unit tests passed successfully!");
