// 錯誤教案 #1：整數溢位（int 超過範圍後繞回，程式不會報錯）
#include <iostream>

int factorial(int n) {
  int result = 1;                        //@ @tts [next] 先把答案設為 1
  for (int i = 2; i <= n; i++) {         //@ @tts [next] i 從 2 一直乘到 n
    result = result * i;                 //@ @guide 執行後 result 變成 result 乘 i；超過 int 的範圍時數字會繞回 @bug int 最大只能到 2147483647。超過後數字會繞回成負數或怪值，而程式不會報錯 @tts [next] 把 result 乘上 {i}，超出 int 範圍時數字就繞回
  }                                      //@ @tts [next] 這一圈結束
  return result;                         //@ @tts [next] 回傳 {result}
}                                        //@ @tts [next] 離開 factorial

int main() {                             //@ @tts [next] 程式開始，我們要算 10! 和 13!
  std::cout << "10! = " << factorial(10) << std::endl;  //@ @tts [next] 10! 在 int 的範圍內，結果正確
  std::cout << "13! = " << factorial(13) << std::endl;  //@ @tts [next] 13! 已經超過 int 的範圍，結果會錯
  return 0;                              //@ @tts [next] 回傳 0，main 即將結束
}  //@ @tts [continue] 教案播放完畢
