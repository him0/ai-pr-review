import axios from "axios";
import { OpenAI } from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPOSITORY = process.env.REPOSITORY;
const PR_NUMBER = parseInt(process.env.PR_NUMBER || "0");
const PR_API_URL = `https://api.github.com/repos/${REPOSITORY}/pulls/${PR_NUMBER}`;

const getPullRequestDiff = async (): Promise<string> => {
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3.diff",
  };
  const diffResponse = await axios.get(PR_API_URL, { headers });
  return diffResponse.data;
};

const createIgnorePrReviewsPrompt = async (): Promise<string> => {
  const url = `${PR_API_URL}/comments`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}` };
  const response = await axios.get(url, { headers });
  const comments = response.data;
  if (comments.length === 0) {
    return "";
  }
  let ignorePrompt =
    "- However, please ensure the content does not duplicate the following existing comments:\n";
  for (const comment of comments) {
    const body = comment.body;
    const path = comment.path;
    const line = comment.line || comment.original_line;
    ignorePrompt += `  - file "${path}", line ${line}: ${body}\n`;
  }
  return ignorePrompt;
};

const createPrompt = (codeDiff: string, language = "Japanese"): string => {
  let prompt =
    `Review the following code:\n\n${codeDiff}\n\n` +
    "- Be sure to comment on areas for improvement.\n" +
    `- Please make review comments in ${language}.\n` +
    '- Please prefix your review comments with one of the following labels "MUST:","IMO:","NITS:".\n' +
    "  - MUST: must be modified\n" +
    "  - IMO: personal opinion or minor proposal\n" +
    "  - NITS: Proposals that do not require modification\n" +
    "- The following json format should be followed.\n" +
    '{"files":[{"fileName":"<file_name>","reviews": [{"lineNumber":<line_number>,"reviewComment":"<review comment>"}]}]}\n' +
    '- If there is no review comment, please answer {"files":[]}\n';
  prompt += createIgnorePrReviewsPrompt();
  return prompt;
};

const getAiReviewContent = async (
  prompt: string
): Promise<string | undefined> => {
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
  const chatCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  return chatCompletion.choices[0].message.content || undefined;
};

const postReviewComments = async (reviewFiles) => {
  const url = `${PR_API_URL}/commits`;
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  };
  const prCommitsResponse = await axios.get(url, { headers });
  const prCommits = prCommitsResponse.data;
  const lastCommit = prCommits[prCommits.length - 1].sha;

  for (const file of reviewFiles.files) {
    for (const review of file.reviews) {
      const commentUrl = `${PR_API_URL}/comments`;
      const commentData = {
        body: review.reviewComment,
        commit_id: lastCommit,
        path: file.fileName,
        line: parseInt(review.lineNumber),
      };
      try {
        await axios.post(commentUrl, commentData, { headers });
      } catch (error) {
        console.error(
          `Error posting comment: ${error.response?.status} ${error.response?.statusText}`
        );
        console.error(`Request data: ${JSON.stringify(commentData)}`);
        // エラーレスポンスの詳細をログに出力
        console.error(`Error details: ${error.response?.data?.message}`);
        console.log(error.response?.data?.errors[0]);
        console.log(error.response?.data?.errors[1]);
      }
    }
  }
};

const main = async () => {
  const codeDiff = await getPullRequestDiff();
  const prompt = createPrompt(codeDiff);
  const reviewJson = await getAiReviewContent(prompt);
  if (!reviewJson) {
    return;
  }
  const reviewFiles = JSON.parse(reviewJson);
  await postReviewComments(reviewFiles);
};

main().catch(console.error);
