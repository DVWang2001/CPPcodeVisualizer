// 錯誤教案 #4：未初始化的變數（看起來正確，不代表正確）
#include <iostream>

int main() {                             //@ @tts [next] 程式開始，我們要把 1 到 5 加起來
  int sum;                               //@ @guide 宣告 sum 但沒有給初值，它的值是不確定的殘留值 @tts [next] 宣告 sum，但沒有給它初值
  for (int i = 1; i <= 5; i++) {         //@ @tts [next] i 從 1 跑到 5
    sum += i;                            //@ @guide 執行後 sum 加上 i；sum 一開始的值不確定，結果不一定對 @bug 區域變數不會自動清零。sum 的初值是記憶體裡的殘留值。這次剛好是 0，所以結果看起來正確；換一台機器或一個編譯器就不一定 @tts [next] 把 {i} 加到 sum 上，但 sum 一開始的值不確定
  }                                      //@ @tts [next] 這一圈結束
  std::cout << "1+2+3+4+5 = " << sum << "（應為 15）" << std::endl;  //@ @tts [next] 印出 sum，應該是 15
  return 0;                              //@ @tts [next] 回傳 0，main 即將結束
}  //@ @tts [continue] 教案播放完畢
