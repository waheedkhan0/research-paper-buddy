import { PGChunk, PGEssay, PGJSON } from "@/types";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import { encode } from "gpt-3-encoder";
import { createClient } from "@supabase/supabase-js";
import * as pdfjsLib from 'pdfjs-dist'

const BASE_URL = "http://www.paulgraham.com/";
const CHUNK_SIZE = 200;
const SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpuaHhleHB5ZW5ka3BscGZ0bmljIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTY4MDg0NDk0NywiZXhwIjoxOTk2NDIwOTQ3fQ.kPn6lFObBjgVhkLqlOol-YyftmuCyDx9iypQYS82y2g";

const getLinks = async () => {
  const supabase = createClient("https://znhxexpyendkplpftnic.supabase.co", SUPABASE_SERVICE_ROLE_KEY!);
  const { data: files, error } = await supabase.storage.from('pdfs').list();
  if (error) {
    console.log("error getting links from storage : ", error);
  }

  const linksArr: { url: string; title: string,file_id: string }[] = [];

  files?.forEach((file : any) => {
    if (file['name']) {
      const linkObj = {
        url: supabase.storage.from('pdfs').getPublicUrl(file['name']).data.publicUrl,
        title: file['name'].replace("pdfs/", "").replace(".pdf", ""),
        file_id: file['id'],
      };

      linksArr.push(linkObj);
    }
  });
  console.log(files);
  return linksArr;
  
};


const getEssay = async (linkObj: { url: string; title: string,file_id: string }) => {
  const { title, url, file_id } = linkObj

  let essay: PGEssay = {
    title: '',
    url: '',
    date: '',
    file_id: file_id,
    thanks: '',
    content: '',
    length: 0,
    tokens: 0,
    chunks: [],
  }

  const fullLink = url
  const pdf = await axios.get(fullLink, { responseType: 'arraybuffer' })
  const pdfData = new Uint8Array(pdf.data)
  // NEW CODE: access the promise property of the PDFDocumentLoadingTask object
  const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise

  // NEW CODE: use the numPages property of the PDFDocumentProxy object
  let text = ''
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i)
    const textContent = await page.getTextContent()
    text += textContent.items
      .map(item => ('str' in item ? item.str : ''))
      .join(' ')
  }

  let cleanedText = text.replace(/\s+/g, ' ')
  cleanedText = cleanedText.replace(/\.([a-zA-Z])/g, '. $1')

  const date = cleanedText.match(/([A-Z][a-z]+ [0-9]{4})/)
  let dateStr = ''
  let textWithoutDate = ''

  if (date) {
    dateStr = date[0]
    textWithoutDate = cleanedText.replace(date[0], '')
  }

  let essayText = textWithoutDate.replace(/\n/g, ' ')
  let thanksTo = ''

  const split = essayText.split('. ').filter(s => s)

  const trimmedContent = essayText.trim()

  essay = {
    title,
    url: fullLink,
    date: dateStr,
    thanks: thanksTo.trim(),
    content: trimmedContent,
    length: trimmedContent.length,
    tokens: encode(trimmedContent).length,
    chunks: [],
  }

  return essay
}


const chunkEssay = async (essay: PGEssay) => {
  const { title, url, date, thanks, content,file_id, ...chunklessSection } = essay

  let essayTextChunks = []

  if (encode(content).length > CHUNK_SIZE) {
    const split = content.split('. ')
    let chunkText = ''

    for (let i = 0; i < split.length; i++) {
      const sentence = split[i]
      const sentenceTokenLength = encode(sentence)
      const chunkTextTokenLength = encode(chunkText).length

      if (chunkTextTokenLength + sentenceTokenLength.length > CHUNK_SIZE) {
        essayTextChunks.push(chunkText)
        chunkText = ''
      }

      // NEW CODE: check if the last character of sentence is a punctuation character
      const punctuation = '.,;:!?'
      if (sentence && punctuation.includes(sentence[sentence.length - 1])) {
        chunkText += sentence + ' '
      } else {
        chunkText += sentence + '. '
      }
    }

    essayTextChunks.push(chunkText.trim())
  } else {
    essayTextChunks.push(content.trim())
  }

  const essayChunks = essayTextChunks.map(text => {
    const trimmedText = text.trim()

    const chunk: PGChunk = {
      essay_title: title,
      essay_url: url,
      file_id : file_id,
      essay_date: date,
      essay_thanks: thanks,
      content: trimmedText,
      content_length: trimmedText.length,
      content_tokens: encode(trimmedText).length,
      embedding: [],
    }

    return chunk
  })

  if (essayChunks.length > 1) {
    for (let i = 0; i < essayChunks.length; i++) {
      const chunk = essayChunks[i]
      const prevChunk = essayChunks[i - 1]

      if (chunk.content_tokens < 100 && prevChunk) {
        prevChunk.content += ' ' + chunk.content
        prevChunk.content_length += chunk.content_length
        prevChunk.content_tokens += chunk.content_tokens
        essayChunks.splice(i, 1)
        i--
      }
    }
  }

  const chunkedSection: PGEssay = {
    ...essay,
    chunks: essayChunks
  };

  return chunkedSection;
}

(async () => {
  const links = await getLinks();

  let essays = [];

  for (let i = 0; i < links.length; i++) {
    const essay = await getEssay(links[i]);
    const chunkedEssay = await chunkEssay(essay);
    essays.push(chunkedEssay);
  }

  const json: PGJSON = {
    current_date: "2023-04-10",
    author: "Waheed Khan",
    url: "",
    length: essays.reduce((acc, essay) => acc + essay.length, 0),
    tokens: essays.reduce((acc, essay) => acc + essay.tokens, 0),
    essays
  };

  fs.writeFileSync("scripts/pg.json", JSON.stringify(json));
})();
